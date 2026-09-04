/**
 * Issue #56: the search pipeline. Runs the brief's algorithm
 * (docs/prompts/001-initial-brief.md lines 72-84) end to end — rank connection candidates,
 * fetch flights/stays/transfers for the survivors, assemble and score whole itineraries,
 * group variants — against whatever adapters are registered, staged so stage 1 spends
 * nothing metered and later stages only spend what the caller explicitly confirmed.
 *
 * See `types.ts`'s module doc comment for why the public shape is an async generator of
 * cumulative snapshots rather than a rune-based store, and `price-calendar.ts`'s module doc
 * comment for the three-tier cost model (free / cheap-calendar / expensive-per-date) this
 * pipeline stages against.
 *
 * ## Cancellation
 *
 * `options.signal` is threaded into every `ProviderContext` this pipeline builds, so a
 * provider's own network call aborts the moment the caller aborts (`AbortController.abort()`
 * — fetch's native behaviour). On top of that, `signal.aborted` is checked at every phase
 * boundary below (after resolving airports, after ranking candidates, after fetching the
 * once-per-search location transfers, and inside the per-candidate consumption loop) so no
 * *new* provider call is ever started once a search has been superseded — the two together
 * are what "a superseded search must genuinely stop" (issue #56) means in code: in-flight
 * calls abort quickly, and nothing new gets queued behind them.
 */

import { DEFAULT_MAX_CANDIDATES, findConnectionCandidates, hasKnownDirectRoute } from '../algorithm/connections';
import type { ConnectionAirportInfo } from '../algorithm/connections';
import { buildItineraries } from '../algorithm/build';
import { DEFAULT_SCORING_WEIGHTS, rankItineraries } from '../algorithm/score';
import type { ScoringWeights } from '../algorithm/score';
import { getAirport } from '../data/airports';
import {
	DEFAULT_LANDING_TO_TRANSPORT_RULES,
	type Airport,
	type FlightOffer,
	type IataAirlineCode,
	type IataAirportCode,
	type Itinerary,
	type LandingToTransportRule,
	type Stay,
	type Transfer
} from '../domain';
import { runCostAwareSearch } from '../providers/budget';
import { isProviderUsable } from '../providers/registry';
import type {
	AvailableKeys,
	FlightProvider,
	FlightSearchQuery,
	ProviderId,
	StayProvider,
	TransferProvider
} from '../providers/types';
import { flattenOk, flightCostAwareSources, meteredRequestsUsed, pickMeteredWithinBudget, stayCostAwareSources } from './cost-aware';
import { groupItineraryResults } from './group';
import {
	estimatePriceCalendarWidenCost,
	runPriceCalendarWiden
} from './price-calendar';
import type { PriceCalendarOutcome, PriceCalendarQuery } from './price-calendar';
import { createCheapRoutesFlightProvider } from './providers-adapter';
import { recordProviderResult, SourceTracker } from './provenance';
import type { RecordProviderCall } from './provenance';
import { raceToCompletion } from './race';
import {
	applyLandingBuffer,
	DEFAULT_STAY_RADIUS_KM,
	estimateTaxiFareForLeg,
	fetchBestTransfer,
	fetchConnectionResources,
	pickBestTransfer,
	pickLandingToTransportTime
} from './resources';
import type {
	ConnectionCandidate,
	ConnectionTransferOptions,
	ItineraryResult,
	ItinerarySources,
	OuterTransferOptions,
	ProviderStatus,
	SearchDependencies,
	SearchQuery,
	SearchRunOptions,
	SearchSnapshot,
	SearchStage,
	TransferLegOptions,
	WidenOption,
	WidenRequest
} from './types';

/** Empty alternatives for a leg that was never asked about (no `originLocation`/
 * `destinationLocation` on this query) — `fetchOuterTransfers` returns this rather than
 * `undefined`, so a caller (`SearchSnapshot.outerTransferOptions`) never has to distinguish
 * "not asked for" from "asked for, nothing found" itself. */
const NO_TRANSFER_LEG_OPTIONS: TransferLegOptions = { candidates: [] };

/** Resolves the two "outer" legs (leaving `originLocation`, arriving at
 * `destinationLocation`) once per search — they never depend on which connection candidate
 * ends up winning, so re-fetching them per candidate would just be the same query repeated.
 *
 * Issue #114: also returns each leg's full candidate list and taxi fare estimate
 * (`TransferLegOptions`), the outer-leg equivalent of `resources.ts`'s per-connection
 * candidates — a `TransportPicker` for "travel to the airport"/"travel to the destination"
 * needs real alternatives exactly the same way the connection-side pickers do. */
async function fetchOuterTransfers(
	query: SearchQuery,
	originAirport: Airport,
	destinationAirport: Airport,
	transferProviders: readonly TransferProvider[],
	keys: AvailableKeys,
	signal: AbortSignal,
	landingToTransportRules: readonly LandingToTransportRule[],
	sources: SourceTracker,
	record: RecordProviderCall
): Promise<{
	transferToOriginAirport?: Transfer;
	transferToDestinationLocation?: Transfer;
	transferToOriginAirportOptions: TransferLegOptions;
	transferToDestinationLocationOptions: TransferLegOptions;
}> {
	const [originOutcome, destinationOutcome] = await Promise.all([
		query.originLocation
			? fetchBestTransfer(
					{ from: query.originLocation.coordinates, to: originAirport.coordinates },
					transferProviders,
					keys,
					signal,
					sources,
					record
				)
			: undefined,
		query.destinationLocation
			? fetchBestTransfer(
					{ from: destinationAirport.coordinates, to: query.destinationLocation.coordinates },
					transferProviders,
					keys,
					signal,
					sources,
					record
				)
			: undefined
	]);

	// The destination-location leg starts right after landing, same as transferToHotel does
	// for a connection — see resources.ts's own comment on why the buffer only applies to
	// legs that begin at a runway, never one ending at a departure gate. Applied to every
	// candidate, not just the pick, for the same reason resources.ts now does the same for
	// transferToHotel: a traveller who picks a different mode via TransportPicker still needs
	// this padding, and re-deriving the pick from the buffered list keeps one code path
	// deciding "which is best" instead of two that could disagree.
	const destinationCandidates = (destinationOutcome?.candidates ?? []).map((transfer) =>
		applyLandingBuffer(transfer, pickLandingToTransportTime(landingToTransportRules, destinationAirport.sizeClass), sources)
	);
	const transferToDestinationLocation = pickBestTransfer(destinationCandidates);

	// Sequenced after both `fetchBestTransfer` calls above resolve, never alongside them —
	// see `estimateTaxiFareForLeg`'s own doc comment for why that ordering is what keeps this
	// a cache hit rather than a second driving-route request for the same pair.
	const [originTaxiFareEstimate, destinationTaxiFareEstimate] = await Promise.all([
		query.originLocation
			? estimateTaxiFareForLeg(
					originOutcome?.candidates ?? [],
					query.originLocation.coordinates,
					originAirport.coordinates,
					originAirport.country.isoCode,
					signal,
					record
				)
			: undefined,
		query.destinationLocation
			? estimateTaxiFareForLeg(
					destinationCandidates,
					destinationAirport.coordinates,
					query.destinationLocation.coordinates,
					destinationAirport.country.isoCode,
					signal,
					record
				)
			: undefined
	]);

	return {
		transferToOriginAirport: originOutcome?.selected,
		transferToDestinationLocation,
		transferToOriginAirportOptions: query.originLocation
			? { candidates: originOutcome?.candidates ?? [], taxiFareEstimate: originTaxiFareEstimate }
			: NO_TRANSFER_LEG_OPTIONS,
		transferToDestinationLocationOptions: query.destinationLocation
			? { candidates: destinationCandidates, taxiFareEstimate: destinationTaxiFareEstimate }
			: NO_TRANSFER_LEG_OPTIONS
	};
}

/** Adapts a `SearchDependencies.resolveAirport` into `algorithm/connections.ts`'s
 * `AirportLookup` shape — exactly the wiring that file's own doc comment anticipates once
 * issue #11's dataset exists (it now does): `(code) => getAirport(code).then((a) => a &&
 * { coordinates, sizeClass, countryCode: a.country.isoCode })`. */
function airportLookupFrom(
	resolveAirport: NonNullable<SearchDependencies['resolveAirport']>
): (code: IataAirportCode) => Promise<ConnectionAirportInfo | undefined> {
	return async (code) => {
		const airport = await resolveAirport(code);
		return airport && { coordinates: airport.coordinates, sizeClass: airport.sizeClass, countryCode: airport.country.isoCode };
	};
}

/**
 * The date range a provider is asked to search for one leg. `SearchQuery` only models the
 * trip's overall departure window (leaving the origin) and arrival window (reaching the
 * destination) — the brief never asks the traveller to date-bound each leg separately — so
 * the outbound leg is searched across the whole departure window, and the onward leg across
 * a window starting at the earliest the traveller would accept arriving (a loose but
 * safe lower bound on when it could depart) through the latest acceptable arrival.
 * `build.ts`'s own layover and non-negative-free-time filters discard whatever this
 * approximation returns that doesn't actually connect, so over-including candidate dates
 * here is safe; under-including would silently drop a valid itinerary.
 */
function outboundLegQuery(
	query: SearchQuery,
	origin: IataAirportCode,
	destination: IataAirportCode,
	currency: SearchDependencies['currency']
): FlightSearchQuery {
	return {
		origin,
		destination,
		earliestDeparture: query.soonestDeparture,
		latestDeparture: query.latestDeparture ?? query.latestArrival,
		travellers: query.travellers,
		currency
	};
}

function onwardLegQuery(
	query: SearchQuery,
	origin: IataAirportCode,
	destination: IataAirportCode,
	currency: SearchDependencies['currency']
): FlightSearchQuery {
	return {
		origin,
		destination,
		earliestDeparture: query.soonestArrival ?? query.soonestDeparture,
		latestDeparture: query.latestArrival,
		travellers: query.travellers,
		currency
	};
}

/** Same leg-splitting logic as `outboundLegQuery`/`onwardLegQuery`, reshaped for Flights
 * Sky's own `PriceCalendarQuery` — `departDate` is a required parameter on the real endpoint
 * but not a narrowing one (a calendar call returns the same fixed 366-day window regardless
 * of its value — `flights-sky-types.ts`'s own doc comment), so any date in the search's
 * window is as good as any other here. */
function priceCalendarLegQueries(
	query: SearchQuery,
	candidateAirportCode: IataAirportCode,
	currency: SearchDependencies['currency']
): { outbound: PriceCalendarQuery; onward: PriceCalendarQuery } {
	return {
		outbound: {
			origin: query.originAirport,
			destination: candidateAirportCode,
			departDate: query.soonestDeparture,
			currency
		},
		onward: {
			origin: candidateAirportCode,
			destination: query.destinationAirport,
			departDate: query.soonestArrival ?? query.soonestDeparture,
			currency
		}
	};
}

/** Reconstructs per-field provenance for one built `Itinerary` from the tags `sources`
 * collected while fetching — see `provenance.ts`'s doc comment for why a `WeakMap` keyed by
 * object identity is reliable here. `outboundFlight`/`onwardFlight` are asserted present
 * because every offer this pipeline hands to `buildItineraries` was tagged the moment it was
 * fetched (`cost-aware.ts`'s `flightCostAwareSources`); a missing tag would be a wiring bug
 * in this module, not an external data problem, so it fails loudly rather than fabricating a
 * placeholder source. */
function sourcesForItinerary(itinerary: Itinerary, sources: SourceTracker): ItinerarySources {
	const outboundFlight = sources.sourceFor(itinerary.outboundFlight);
	const onwardFlight = sources.sourceFor(itinerary.onwardFlight);
	if (!outboundFlight || !onwardFlight) {
		throw new Error('search pipeline invariant violated: a built itinerary references an untagged flight offer');
	}
	return {
		outboundFlight,
		onwardFlight,
		stay: sources.sourceFor(itinerary.stay),
		transferToHotel: sources.sourceFor(itinerary.transferToHotel),
		transferToConnectionAirport: sources.sourceFor(itinerary.transferToConnectionAirport),
		transferToOriginAirport: sources.sourceFor(itinerary.transferToOriginAirport),
		transferToDestinationLocation: sources.sourceFor(itinerary.transferToDestinationLocation)
	};
}

/** How one candidate's two legs get their flight offers — every free provider plus, in
 * `widenSearch`, whichever metered ones fit the traveller's confirmed budget. Isolating this
 * as an injected strategy is what lets `processCandidate` below stay one function shared by
 * `runSearch` and `widenSearch`, instead of duplicating everything else it does (resource
 * fetching, building, scoring, provenance) across two near-identical copies. */
type FetchLegsFn = (
	outboundQuery: FlightSearchQuery,
	onwardQuery: FlightSearchQuery
) => Promise<{ outboundOffers: FlightOffer[]; onwardOffers: FlightOffer[] }>;

interface ProcessCandidateInput {
	candidate: ConnectionCandidate;
	query: SearchQuery;
	originAirport: Airport;
	destinationAirport: Airport;
	resolveAirport: NonNullable<SearchDependencies['resolveAirport']>;
	fetchLegs: FetchLegsFn;
	/** Every registered stay provider — `fetchConnectionResources` decides internally (via
	 * `runCostAwareSearch`) which ones actually run. */
	stayProviders: readonly StayProvider[];
	transferProviders: readonly TransferProvider[];
	keys: AvailableKeys;
	signal: AbortSignal;
	stayRadiusKm: number;
	landingToTransportRules: readonly LandingToTransportRule[];
	weights: ScoringWeights;
	airlinesToAvoid: readonly IataAirlineCode[];
	/** Threaded into the two leg queries this function builds itself — see
	 * `SearchDependencies.currency`'s own doc comment for why every provider in one search
	 * is asked for the same currency. */
	currency: SearchDependencies['currency'];
	transferToOriginAirport?: Transfer;
	transferToDestinationLocation?: Transfer;
	sources: SourceTracker;
	record: RecordProviderCall;
}

/**
 * Issue #115: how many candidates `runSearch` will try in its fallback sweep when the
 * geography-ranked primary batch (`findConnectionCandidates`'s own `DEFAULT_MAX_CANDIDATES`,
 * or whatever `options.maxCandidates` overrides it to) produces zero itineraries.
 *
 * `DEFAULT_MAX_CANDIDATES` (6) was sized around a *metered* flight provider's monthly quota
 * ("each survivor costs two metered fare searches downstream" — that constant's own doc
 * comment). That threat model doesn't apply here: `fetchLegs` below never has a `widenTo`,
 * so `runSearch` never spends a metered flight request no matter how many candidates it
 * tries. What it does cost is real, but free — a keyless Ryanair round trip per leg — and
 * that cost buys something specific: Ryanair's `farfnd/v4/oneWayFares` returns only the
 * single cheapest fare in a date range per leg, not a timetable (`ryanair.ts`'s own doc
 * comment), so whether a candidate's two independently-cheapest dates land in the right
 * order is close to a coin flip. A route can have plenty of genuinely workable stopovers
 * and still have its top 6 by geography all lose that coin flip on a given day — measured
 * for BCN -> OTP (issue #115): 8 of 25 real candidates had a workable fare order, and none
 * of the 8 were in the default top 6 (the nearest was #9).
 *
 * Only spent when the free primary batch already came back empty, the same "expensive only
 * on the rare nothing-found path" rule `checkDirectRoute` below already follows for the
 * same reason — an ordinary search that already found something never triggers this.
 */
export const FALLBACK_MAX_CANDIDATES = 24;

/** Builds one `processCandidate` task per candidate, sharing everything about this search
 * except which candidate it's for — the shared shape `runSearch`'s primary batch and its
 * issue #115 fallback sweep both build tasks from, so the fallback never has to repeat the
 * long list of fields the primary batch already assembled. */
function buildCandidateTasks(
	candidatesToProcess: readonly ConnectionCandidate[],
	base: Omit<ProcessCandidateInput, 'candidate'>
): Promise<CandidateOutcome>[] {
	return candidatesToProcess.map((candidate) => processCandidate({ ...base, candidate }));
}

/** Issue #114: both connection-side legs' alternatives with nothing found yet — the
 * `CandidateOutcome`/empty-result equivalent of `stayCandidates: []`. */
const NO_CONNECTION_TRANSFER_OPTIONS: ConnectionTransferOptions = {
	transferToHotel: { candidates: [] },
	transferToConnectionAirport: { candidates: [] }
};

interface CandidateOutcome {
	candidate: ConnectionCandidate;
	itineraries: ItineraryResult[];
	/** Every `Stay` `fetchConnectionResources` found near this candidate, cheapest first,
	 * gender-eligibility not applied — issue #80's candidate list, carried through so a
	 * `SearchSnapshot` can keep it rather than only the pipeline's already-decided pick.
	 * Empty when the candidate produced no resources at all (nothing found, or every part
	 * failed to resolve). */
	stayCandidates: Stay[];
	/** Issue #114: both connection-side legs' transfer alternatives and taxi fare estimates,
	 * the transfer equivalent of `stayCandidates` above. */
	transferOptions: ConnectionTransferOptions;
}

/**
 * Everything issue #56's algorithm steps 2-5 do for one connection candidate: fetch both
 * legs' flights and the candidate's stay/transfer resources (concurrently — neither depends
 * on the other), assemble whatever itineraries that data supports, score them, and attach
 * provenance. Returns an empty list, never a throw, for every way a candidate can fail to
 * pan out (no airport record, no flights either direction, no stay reachable, or a
 * currency mismatch `buildItineraries` itself refuses to total) — "one provider failing
 * must never fail a search" applies at the granularity of one candidate here, not just one
 * provider.
 */
async function processCandidate(input: ProcessCandidateInput): Promise<CandidateOutcome> {
	const empty: CandidateOutcome = {
		candidate: input.candidate,
		itineraries: [],
		stayCandidates: [],
		transferOptions: NO_CONNECTION_TRANSFER_OPTIONS
	};
	if (input.signal.aborted) return empty;

	const connectionAirport = await input.resolveAirport(input.candidate.airportCode);
	if (!connectionAirport) return empty; // No dataset entry — nowhere to send the traveller.

	const outboundQuery = outboundLegQuery(
		input.query,
		input.query.originAirport,
		input.candidate.airportCode,
		input.currency
	);
	const onwardQuery = onwardLegQuery(
		input.query,
		input.candidate.airportCode,
		input.query.destinationAirport,
		input.currency
	);

	const [{ outboundOffers, onwardOffers }, resources] = await Promise.all([
		input.fetchLegs(outboundQuery, onwardQuery),
		fetchConnectionResources({
			connectionCoordinates: connectionAirport.coordinates,
			connectionAirportSize: connectionAirport.sizeClass,
			connectionCountryCode: connectionAirport.country.isoCode,
			stayProviders: input.stayProviders,
			transferProviders: input.transferProviders,
			keys: input.keys,
			signal: input.signal,
			stayRadiusKm: input.stayRadiusKm,
			checkIn: input.query.soonestDeparture,
			checkOut: input.query.latestArrival,
			landingToTransportRules: input.landingToTransportRules,
			sources: input.sources,
			record: input.record,
			travellers: input.query.travellers,
			females: input.query.females
		})
	]);

	if (input.signal.aborted) return empty;
	// Issue #94: `resources` itself is never `undefined` any more — a missing stay
	// degrades `resources.stay` to `undefined` rather than dropping the candidate, so the
	// only thing that still empties this candidate outright is having no flights at all.
	if (outboundOffers.length === 0 || onwardOffers.length === 0) return empty;

	try {
		const itineraries = buildItineraries({
			originAirport: input.originAirport,
			destinationAirport: input.destinationAirport,
			outboundOffers,
			onwardOffers,
			connectionAirports: { [input.candidate.airportCode]: connectionAirport },
			connectionResources: { [input.candidate.airportCode]: resources },
			originLocation: input.query.originLocation,
			transferToOriginAirport: input.transferToOriginAirport,
			destinationLocation: input.query.destinationLocation,
			transferToDestinationLocation: input.transferToDestinationLocation,
			minLayoverTime: input.query.minLayoverTime,
			waitingTimeRules: input.query.waitingTimeRules,
			// Issue #106: without this, `buildItineraries` defaults to 1 traveller and a
			// group search silently gets a solo total — see `Itinerary.travellers`'s own
			// doc comment for exactly what this scales.
			travellers: input.query.travellers
		});

		const results = rankItineraries(itineraries, input.airlinesToAvoid, input.weights).map(
			(score): ItineraryResult => ({ score, sources: sourcesForItinerary(score.itinerary, input.sources) })
		);
		return {
			candidate: input.candidate,
			itineraries: results,
			stayCandidates: resources.stayCandidates,
			transferOptions: {
				transferToHotel: {
					candidates: resources.transferToHotelCandidates,
					taxiFareEstimate: resources.transferToHotelTaxiFareEstimate
				},
				transferToConnectionAirport: {
					candidates: resources.transferToConnectionAirportCandidates,
					taxiFareEstimate: resources.transferToConnectionAirportTaxiFareEstimate
				}
			}
		};
	} catch {
		// buildItineraries throws only for a currency mismatch across a candidate's own
		// parts (its own doc comment) — SearchDependencies.currency asks every provider for
		// the same one to make this rare. Degrading this one candidate, rather than the
		// whole search, is the same "one failure must never fail a search" contract this
		// pipeline holds for a provider error.
		return empty;
	}
}

/** Issue #114: no outer-leg alternatives resolved yet — every `SearchSnapshot` before
 * `fetchOuterTransfers` completes reports this, so a UI never sees a missing field, only an
 * empty one, before the first real answer arrives. */
const NO_OUTER_TRANSFER_OPTIONS: OuterTransferOptions = {
	transferToOriginAirport: { candidates: [] },
	transferToDestinationLocation: { candidates: [] }
};

/** Small closure factory shared by `runSearch` and `widenSearch` so both build a
 * `SearchSnapshot` the same way — bumping `sequence`, re-deriving `itineraryGroups` from
 * whatever has accumulated in `results` so far, and reading the live `providerStatus`,
 * `stayCandidatesByConnection` and `transferOptionsByConnection` maps (issue #80/#114: these
 * are what keep a connection's full stay/transfer candidate lists alive into the snapshot
 * instead of collapsing to one pick each). `outerTransferOptionsRef` is a mutable holder
 * (not a map — there is only ever one value, computed once) so a caller can update it in
 * place the moment `fetchOuterTransfers` resolves and have every snapshot from then on pick
 * up the new value, the same way the maps below are read live rather than passed by value. */
function makeSnapshotFn(
	results: ItineraryResult[],
	providerStatus: Map<ProviderId, ProviderStatus>,
	stayCandidatesByConnection: Map<IataAirportCode, Stay[]>,
	transferOptionsByConnection: Map<IataAirportCode, ConnectionTransferOptions>,
	outerTransferOptionsRef: { current: OuterTransferOptions }
) {
	let sequence = 0;
	return function snapshot(
		stage: SearchStage,
		candidates: ConnectionCandidate[],
		done: boolean,
		widenOptions: WidenOption[] = [],
		hasDirectRoute = false
	): SearchSnapshot {
		return {
			sequence: sequence++,
			stage,
			done,
			candidates,
			itineraryGroups: groupItineraryResults(results),
			providers: Object.fromEntries(providerStatus),
			widenOptions,
			stayCandidatesByConnection: Object.fromEntries(stayCandidatesByConnection),
			transferOptionsByConnection: Object.fromEntries(transferOptionsByConnection),
			outerTransferOptions: outerTransferOptionsRef.current,
			hasDirectRoute
		};
	};
}

async function resolveOuterAirports(
	query: SearchQuery,
	resolveAirport: NonNullable<SearchDependencies['resolveAirport']>
): Promise<{ originAirport: Airport; destinationAirport: Airport }> {
	const [originAirport, destinationAirport] = await Promise.all([
		resolveAirport(query.originAirport),
		resolveAirport(query.destinationAirport)
	]);
	if (!originAirport || !destinationAirport) {
		throw new Error(
			`runSearch/widenSearch require both airports to resolve (origin ${query.originAirport}: ` +
				`${originAirport ? 'ok' : 'not found'}, destination ${query.destinationAirport}: ` +
				`${destinationAirport ? 'ok' : 'not found'}) — the search form (issue #16) is expected to ` +
				'validate airport codes against the same dataset before a search is ever started.'
		);
	}
	return { originAirport, destinationAirport };
}

/**
 * Tier 3 ("confirm") widen preview for every candidate, across every REGISTERED flight
 * provider regardless of usability — deliberately not routed through `cost-aware.ts`'s
 * `flightCostAwareSources`, which filters to usable providers only (correct for deciding
 * what can actually run, wrong for a preview that must still show "add a key to widen with
 * Skyscanner for ~2 requests" for a provider with no key yet).
 */
function confirmWidenOptions(
	candidates: readonly ConnectionCandidate[],
	query: SearchQuery,
	allFlightProviders: readonly FlightProvider[],
	keys: AvailableKeys,
	currency: SearchDependencies['currency']
): WidenOption[] {
	const options: WidenOption[] = [];
	for (const candidate of candidates) {
		const outboundQuery = outboundLegQuery(query, query.originAirport, candidate.airportCode, currency);
		const onwardQuery = onwardLegQuery(query, candidate.airportCode, query.destinationAirport, currency);
		for (const provider of allFlightProviders) {
			const requests = provider.estimateSearchOffersCost(outboundQuery) + provider.estimateSearchOffersCost(onwardQuery);
			if (requests <= 0) continue; // Free — not a widen option at all.
			options.push({
				providerId: provider.id,
				kind: 'flight',
				tier: 'confirm',
				label: provider.label,
				candidateAirportCode: candidate.airportCode,
				requests,
				requiresKey: !isProviderUsable(provider, keys)
			});
		}
	}
	return options;
}

/** Tier 2 ("calendar") widen preview for every candidate — see `price-calendar.ts`'s module
 * doc comment for what this tier buys over tier 3. */
function calendarWidenOptions(
	candidates: readonly ConnectionCandidate[],
	query: SearchQuery,
	allFlightProviders: readonly FlightProvider[],
	keys: AvailableKeys,
	currency: SearchDependencies['currency']
): WidenOption[] {
	const options: WidenOption[] = [];
	for (const candidate of candidates) {
		const legs = priceCalendarLegQueries(query, candidate.airportCode, currency);
		options.push(
			...estimatePriceCalendarWidenCost(allFlightProviders, keys, [legs.outbound, legs.onward], candidate.airportCode)
		);
	}
	return options;
}

function widenOptionsForCandidates(
	candidates: readonly ConnectionCandidate[],
	query: SearchQuery,
	allFlightProviders: readonly FlightProvider[],
	keys: AvailableKeys,
	currency: SearchDependencies['currency']
): WidenOption[] {
	return [
		...calendarWidenOptions(candidates, query, allFlightProviders, keys, currency),
		...confirmWidenOptions(candidates, query, allFlightProviders, keys, currency)
	];
}

/**
 * The free tier (tier 1 of 3 — see `price-calendar.ts`'s module doc comment for the other
 * two): ranks connection candidates from free sources only — Ryanair's route graph, the
 * bundled fallback table (both inside `algorithm/connections.ts`), and the build-time
 * Travelpayouts cheap-routes dataset (issue #52, `providers-adapter.ts`'s
 * `createCheapRoutesFlightProvider`) — then fetches flights and transfers for them from
 * every currently-free FLIGHT provider (`fetchLegs` below passes no `widenTo`, which is
 * what guarantees a metered flight provider is never called here), building and scoring
 * whatever itineraries the data supports.
 *
 * Stays are a deliberate exception (issue #94, `resources.ts`'s `fetchCheapestStay`): a
 * metered stay provider whose own cap can absorb this search cheaply enough
 * (`autoWidenStaySources`) still runs here, the moment a key exists — a binary "stage 1
 * spends nothing metered, full stop" rule was written for Sky Scrapper's 20-a-month quota
 * and, applied uniformly to Agoda's 500, made pricing a bed structurally unreachable.
 *
 * Yields a `SearchSnapshot` whose `stage` moves through `'candidates'` once ranking is done,
 * then `'stage1'` again for each candidate as its data finishes arriving (in completion
 * order — `race.ts`), then a final one with `done: true`.
 *
 * Issue #115: if this batch produces zero itineraries, `runSearch` tries more of the same
 * free candidates (up to `FALLBACK_MAX_CANDIDATES`) before giving up — see that constant's
 * own doc comment for why a route with real stopovers can still lose on its top-ranked few.
 */
export async function* runSearch(
	query: SearchQuery,
	deps: SearchDependencies,
	options: SearchRunOptions = {}
): AsyncGenerator<SearchSnapshot, void, void> {
	const signal = options.signal ?? new AbortController().signal;
	const stayRadiusKm = options.stayRadiusKm ?? DEFAULT_STAY_RADIUS_KM;
	const resolveAirport = deps.resolveAirport ?? getAirport;
	const currency = deps.currency;

	const providerStatus = new Map<ProviderId, ProviderStatus>();
	const record: RecordProviderCall = (provider, result) => recordProviderResult(providerStatus, provider, result);
	const sources = new SourceTracker();
	const results: ItineraryResult[] = [];
	const stayCandidatesByConnection = new Map<IataAirportCode, Stay[]>();
	const transferOptionsByConnection = new Map<IataAirportCode, ConnectionTransferOptions>();
	const outerTransferOptionsRef = { current: NO_OUTER_TRANSFER_OPTIONS };
	const snapshot = makeSnapshotFn(
		results,
		providerStatus,
		stayCandidatesByConnection,
		transferOptionsByConnection,
		outerTransferOptionsRef
	);

	const { originAirport, destinationAirport } = await resolveOuterAirports(query, resolveAirport);
	if (signal.aborted) {
		yield snapshot('done', [], true);
		return;
	}

	// The build-time Travelpayouts cheap-routes dataset (issue #52) joins the registry's own
	// flight providers as one more route-graph source — see `createCheapRoutesFlightProvider`'s
	// own doc comment for why it's wrapped as a `FlightProvider` rather than passed some
	// narrower shape: `findConnectionCandidates` takes real `FlightProvider`s directly and
	// classifies free vs metered itself (issue #59's rebase onto the merged provider
	// interface). Its `estimateSearchOffersCost` always reports `0`, so it never appears as a
	// metered provider anywhere else this list is used (widen previews, offer fetching).
	const allFlightProviders = [...deps.registry.ofKind('flight'), createCheapRoutesFlightProvider()];
	const allStayProviders = deps.registry.ofKind('stay');
	const allTransferProviders = deps.registry.usable('transfer', deps.keys);
	const landingToTransportRules = query.landingToTransportRules ?? DEFAULT_LANDING_TO_TRANSPORT_RULES;

	// Issue #107: asked only when this search's own results end up empty, from the same free
	// sources `findConnectionCandidates` already queries. Never a second, unrelated lookup,
	// and never a metered one. Cheap enough to call on the rare "nothing came back" path,
	// wasteful to call on every ordinary search that finds something, which is why this is a
	// closure rather than an eager value.
	const checkDirectRoute = () =>
		signal.aborted
			? Promise.resolve(false)
			: hasKnownDirectRoute(
					{
						originAirport: query.originAirport,
						destinationAirport: query.destinationAirport,
						soonestDeparture: query.soonestDeparture
					},
					{ flightProviders: allFlightProviders, providerKeys: deps.keys, signal }
				);

	const candidates = await findConnectionCandidates(
		{
			originAirport: query.originAirport,
			destinationAirport: query.destinationAirport,
			forbiddenConnectionCountries: query.forbiddenConnectionCountries,
			forbiddenConnectionAirports: query.forbiddenConnectionAirports,
			allowedConnectionAirports: query.allowedConnectionAirports,
			soonestDeparture: query.soonestDeparture
		},
		{
			flightProviders: allFlightProviders,
			providerKeys: deps.keys,
			airportLookup: airportLookupFrom(resolveAirport),
			maxCandidates: options.maxCandidates,
			signal
			// meteredRequestBudget intentionally omitted (default 0): this is the line that
			// guarantees stage 1 spends nothing, even as connections.ts's own last-resort
			// fallback for an origin with zero free edges (its own doc comment on the field).
		}
	);

	const widenOptions = widenOptionsForCandidates(candidates, query, allFlightProviders, deps.keys, currency);
	yield snapshot('candidates', candidates, false, widenOptions);

	if (signal.aborted || candidates.length === 0) {
		// No stopover candidate survived ranking at all, the common shape for a well-served
		// direct route (any detour through a third city fails `maxDetourRatio` outright), so
		// this is exactly the case the empty-results UI needs `hasDirectRoute` for.
		const hasDirectRoute = candidates.length === 0 ? await checkDirectRoute() : false;
		yield snapshot('done', candidates, true, widenOptions, hasDirectRoute);
		return;
	}

	const {
		transferToOriginAirport,
		transferToDestinationLocation,
		transferToOriginAirportOptions,
		transferToDestinationLocationOptions
	} = await fetchOuterTransfers(
		query,
		originAirport,
		destinationAirport,
		allTransferProviders,
		deps.keys,
		signal,
		landingToTransportRules,
		sources,
		record
	);
	outerTransferOptionsRef.current = {
		transferToOriginAirport: transferToOriginAirportOptions,
		transferToDestinationLocation: transferToDestinationLocationOptions
	};

	if (signal.aborted) {
		yield snapshot('done', candidates, true, widenOptions);
		return;
	}

	// No `widenTo`: only free FLIGHT providers ever run here. This one line is what makes
	// stage 1's "no metered flight provider is ever called" guarantee hold, delegated
	// entirely to `providers/budget`'s own contract rather than a filter this file
	// maintains itself. Stays follow a different, quota-aware rule inside
	// `fetchConnectionResources` below — see this function's own doc comment (issue #94).
	const fetchLegs: FetchLegsFn = async (outboundQuery, onwardQuery) => {
		const [outboundResult, onwardResult] = await Promise.all([
			runCostAwareSearch(flightCostAwareSources(allFlightProviders, outboundQuery, deps.keys, signal, sources, record)),
			runCostAwareSearch(flightCostAwareSources(allFlightProviders, onwardQuery, deps.keys, signal, sources, record))
		]);
		return { outboundOffers: flattenOk(outboundResult), onwardOffers: flattenOk(onwardResult) };
	};

	const candidateInputBase: Omit<ProcessCandidateInput, 'candidate'> = {
		query,
		originAirport,
		destinationAirport,
		resolveAirport,
		fetchLegs,
		stayProviders: allStayProviders,
		transferProviders: allTransferProviders,
		keys: deps.keys,
		signal,
		stayRadiusKm,
		landingToTransportRules,
		weights: DEFAULT_SCORING_WEIGHTS,
		airlinesToAvoid: query.airlinesToAvoid ?? [],
		currency,
		transferToOriginAirport,
		transferToDestinationLocation,
		sources,
		record
	};

	for await (const outcome of raceToCompletion(buildCandidateTasks(candidates, candidateInputBase))) {
		if (signal.aborted) break;
		results.push(...outcome.itineraries);
		stayCandidatesByConnection.set(outcome.candidate.airportCode, outcome.stayCandidates);
		transferOptionsByConnection.set(outcome.candidate.airportCode, outcome.transferOptions);
		yield snapshot('stage1', candidates, false, widenOptions);
	}

	// Issue #115: the geography-ranked primary batch produced nothing buildable. Before
	// giving up, try more of the same free sources — see `FALLBACK_MAX_CANDIDATES`'s own
	// doc comment for why this is safe (no metered flight spend either way) and only
	// attempted here, never on a search that already found something.
	//
	// Deliberately NOT gated on "did the primary batch already return fewer than its own
	// cap" (which would read as "nothing more to find"): `findConnectionCandidates` treats
	// a failed `listDirectDestinations` call exactly like a true "this airport has no such
	// route" (this file's own module doc comment on `ProviderResult`, and `AGENTS.md`'s
	// "say what you do not know"), so a route graph thinned by ordinary network flakiness
	// looks identical to one that's genuinely small. Re-querying is cheap regardless —
	// route-graph lookups are 24h-cached, so a repeat call mostly replays cache — so it
	// costs little to find out rather than trust a count that might just be bad luck.
	let finalCandidates = candidates;
	let finalWidenOptions = widenOptions;
	const primaryCap = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
	const worthExpanding = FALLBACK_MAX_CANDIDATES > primaryCap;

	if (!signal.aborted && results.length === 0 && worthExpanding) {
		const expandedCandidates = await findConnectionCandidates(
			{
				originAirport: query.originAirport,
				destinationAirport: query.destinationAirport,
				forbiddenConnectionCountries: query.forbiddenConnectionCountries,
				forbiddenConnectionAirports: query.forbiddenConnectionAirports,
				allowedConnectionAirports: query.allowedConnectionAirports,
				soonestDeparture: query.soonestDeparture
			},
			{
				flightProviders: allFlightProviders,
				providerKeys: deps.keys,
				airportLookup: airportLookupFrom(resolveAirport),
				maxCandidates: FALLBACK_MAX_CANDIDATES,
				signal
				// meteredRequestBudget intentionally omitted (default 0), same as the primary
				// call above — re-deriving a larger slice of the same free ranking spends
				// nothing metered no matter how many candidates it returns.
			}
		);
		const alreadyTried = new Set(candidates.map((candidate) => candidate.airportCode));
		const fallbackCandidates = expandedCandidates.filter((candidate) => !alreadyTried.has(candidate.airportCode));

		if (!signal.aborted && fallbackCandidates.length > 0) {
			finalCandidates = [...candidates, ...fallbackCandidates];
			finalWidenOptions = widenOptionsForCandidates(finalCandidates, query, allFlightProviders, deps.keys, currency);
			yield snapshot('stage1', finalCandidates, false, finalWidenOptions);

			for await (const outcome of raceToCompletion(buildCandidateTasks(fallbackCandidates, candidateInputBase))) {
				if (signal.aborted) break;
				results.push(...outcome.itineraries);
				stayCandidatesByConnection.set(outcome.candidate.airportCode, outcome.stayCandidates);
				transferOptionsByConnection.set(outcome.candidate.airportCode, outcome.transferOptions);
				yield snapshot('stage1', finalCandidates, false, finalWidenOptions);
			}
		}
	}

	// Candidates existed (the branch above only skips this point when there were none at
	// all), but none of them produced a single itinerary, even after the issue #115 fallback
	// sweep above. A real find-nothing result, not the well-served-direct-route shape the
	// early exit above targets, but still worth the same free check: nothing rules out the
	// destination also having a direct option that happens to have priced out every
	// candidate this search tried.
	const hasDirectRoute = !signal.aborted && results.length === 0 ? await checkDirectRoute() : false;
	yield snapshot('done', finalCandidates, true, finalWidenOptions, hasDirectRoute);
	return;
}

/**
 * The "confirm" tier (tier 3 of 3): confirms one or more candidates the traveller explicitly
 * picked, for the narrowed date window they chose, spending real metered requests up to
 * `request.maxMeteredRequests` and never more — see `types.ts`'s `WidenRequest` doc comment.
 * Recomputes the candidate ranking itself (free, so re-deriving it costs nothing) rather
 * than trusting a possibly stale list from an earlier `runSearch` snapshot. Its own
 * `SearchSnapshot.stage` moves through `'candidates'`, then `'stage2'` per candidate
 * confirmed, then `'done'` — the same shape as `runSearch`'s stages, reused rather than
 * inventing a parallel set of names for what is structurally the same progression.
 *
 * Scope note: `request.maxMeteredRequests` and its budget accounting
 * (`cost-aware.ts`'s `pickMeteredWithinBudget`, a shared, exact ceiling) apply to FLIGHT
 * providers only — Skyscanner's one-request-per-date cost is exactly what that explicit,
 * traveller-confirmed budget exists to guard. Stay resources here go through the same
 * quota-aware, no-second-opt-in path as the free tier (`fetchConnectionResources`, issue
 * #94): Agoda's 500/month and Booking's 50/month are generous enough, relative to what one
 * search costs, that a configured key already counts as consent, so this tier's own budget
 * never has to reason about a second provider kind. A future issue can extend
 * `WidenRequest` to stay providers too if a tightly-capped one is ever added.
 * See `widenWithPriceCalendar` below for the "calendar" tier (tier 2: cheap, broad, a full
 * year of dates per route).
 */
export async function* widenSearch(
	query: SearchQuery,
	request: WidenRequest,
	deps: SearchDependencies,
	options: SearchRunOptions = {}
): AsyncGenerator<SearchSnapshot, void, void> {
	const signal = options.signal ?? new AbortController().signal;
	const stayRadiusKm = options.stayRadiusKm ?? DEFAULT_STAY_RADIUS_KM;
	const resolveAirport = deps.resolveAirport ?? getAirport;
	const currency = deps.currency;

	const providerStatus = new Map<ProviderId, ProviderStatus>();
	const record: RecordProviderCall = (provider, result) => recordProviderResult(providerStatus, provider, result);
	const sources = new SourceTracker();
	const results: ItineraryResult[] = [];
	const stayCandidatesByConnection = new Map<IataAirportCode, Stay[]>();
	const transferOptionsByConnection = new Map<IataAirportCode, ConnectionTransferOptions>();
	const outerTransferOptionsRef = { current: NO_OUTER_TRANSFER_OPTIONS };
	const snapshot = makeSnapshotFn(
		results,
		providerStatus,
		stayCandidatesByConnection,
		transferOptionsByConnection,
		outerTransferOptionsRef
	);

	const { originAirport, destinationAirport } = await resolveOuterAirports(query, resolveAirport);
	if (signal.aborted) {
		yield snapshot('done', [], true);
		return;
	}

	// Same reasoning as runSearch's own `allFlightProviders` above: the cheap-routes dataset
	// joins the registry's flight providers as one more (always-free) route-graph source.
	const allFlightProviders = [...deps.registry.ofKind('flight'), createCheapRoutesFlightProvider()];
	const allStayProviders = deps.registry.ofKind('stay');
	const allTransferProviders = deps.registry.usable('transfer', deps.keys);
	const landingToTransportRules = query.landingToTransportRules ?? DEFAULT_LANDING_TO_TRANSPORT_RULES;

	const allCandidates = await findConnectionCandidates(
		{
			originAirport: query.originAirport,
			destinationAirport: query.destinationAirport,
			forbiddenConnectionCountries: query.forbiddenConnectionCountries,
			forbiddenConnectionAirports: query.forbiddenConnectionAirports,
			allowedConnectionAirports: query.allowedConnectionAirports,
			soonestDeparture: query.soonestDeparture
		},
		{
			flightProviders: allFlightProviders,
			providerKeys: deps.keys,
			airportLookup: airportLookupFrom(resolveAirport),
			// Issue #115: defaults to the same generous cap `runSearch`'s own fallback sweep
			// can surface (`FALLBACK_MAX_CANDIDATES`'s own doc comment), not the smaller
			// `DEFAULT_MAX_CANDIDATES` — a traveller can only pick a `request.target` from
			// what a `runSearch` snapshot showed them, so this re-derivation has to be able to
			// find that candidate again even when it only appeared via that fallback sweep.
			maxCandidates: options.maxCandidates ?? FALLBACK_MAX_CANDIDATES,
			signal
			// meteredRequestBudget intentionally omitted (default 0): re-deriving the
			// candidate ranking here must stay free too, even though widenSearch itself goes
			// on to spend real requests confirming flight offers for whichever candidate the
			// traveller picked.
		}
	);

	const targetByCode = new Map(request.targets.map((target) => [target.candidateAirportCode, target]));
	const candidates = allCandidates.filter((candidate) => targetByCode.has(candidate.airportCode));

	yield snapshot('candidates', candidates, false);
	if (signal.aborted || candidates.length === 0) {
		yield snapshot('done', candidates, true);
		return;
	}

	const {
		transferToOriginAirport,
		transferToDestinationLocation,
		transferToOriginAirportOptions,
		transferToDestinationLocationOptions
	} = await fetchOuterTransfers(
		query,
		originAirport,
		destinationAirport,
		allTransferProviders,
		deps.keys,
		signal,
		landingToTransportRules,
		sources,
		record
	);
	outerTransferOptionsRef.current = {
		transferToOriginAirport: transferToOriginAirportOptions,
		transferToDestinationLocation: transferToDestinationLocationOptions
	};
	if (signal.aborted) {
		yield snapshot('done', candidates, true);
		return;
	}

	// The one shared, exact ceiling every metered leg fetch below decrements — "never
	// spend more than the caller confirmed" (WidenRequest doc comment). Shared across every
	// candidate and leg in this call, on purpose: a traveller who confirmed "6 requests
	// total" for widening three candidates should get three cheaper, partial confirmations
	// rather than the first candidate silently consuming the whole budget.
	const budget = { remaining: Math.max(0, request.maxMeteredRequests) };

	for (const candidate of candidates) {
		if (signal.aborted || budget.remaining <= 0) break;

		const target = targetByCode.get(candidate.airportCode);
		if (!target) continue; // Filtered into `candidates` above; present here for TS narrowing.

		// Narrowed to exactly the window the traveller confirmed for this candidate — never
		// the original query's full range, which is what keeps this call cheap
		// (docs/PROVIDERS.md: "Skyscanner is spent ... on that one route and date").
		const narrowedQuery: SearchQuery = {
			...query,
			soonestDeparture: target.earliestDeparture,
			latestDeparture: target.latestDeparture
		};

		// Sequential, not `Promise.all`, and against the ONE shared `budget` object above:
		// two metered sources (or two legs) racing on the same "requests remaining" snapshot
		// could together spend more than `maxMeteredRequests` allows, which is exactly the
		// silent overspend this whole module exists to prevent. See `pickMeteredWithinBudget`'s
		// own doc comment.
		const fetchLegs: FetchLegsFn = async (outboundQuery, onwardQuery) => {
			const outboundSources = flightCostAwareSources(allFlightProviders, outboundQuery, deps.keys, signal, sources, record);
			const outboundResult = await runCostAwareSearch(outboundSources, {
				widenTo: pickMeteredWithinBudget(outboundSources, budget.remaining)
			});
			budget.remaining -= meteredRequestsUsed(outboundResult);

			const onwardSources = flightCostAwareSources(allFlightProviders, onwardQuery, deps.keys, signal, sources, record);
			const onwardResult = await runCostAwareSearch(onwardSources, {
				widenTo: pickMeteredWithinBudget(onwardSources, budget.remaining)
			});
			budget.remaining -= meteredRequestsUsed(onwardResult);

			return { outboundOffers: flattenOk(outboundResult), onwardOffers: flattenOk(onwardResult) };
		};

		const outcome = await processCandidate({
			candidate,
			query: narrowedQuery,
			originAirport,
			destinationAirport,
			resolveAirport,
			fetchLegs,
			stayProviders: allStayProviders,
			transferProviders: allTransferProviders,
			keys: deps.keys,
			signal,
			stayRadiusKm,
			landingToTransportRules,
			weights: DEFAULT_SCORING_WEIGHTS,
			airlinesToAvoid: query.airlinesToAvoid ?? [],
			currency,
			transferToOriginAirport,
			transferToDestinationLocation,
			sources,
			record
		});

		results.push(...outcome.itineraries);
		stayCandidatesByConnection.set(outcome.candidate.airportCode, outcome.stayCandidates);
		transferOptionsByConnection.set(outcome.candidate.airportCode, outcome.transferOptions);
		yield snapshot('stage2', candidates, false);
	}

	yield snapshot('done', candidates, true);
	return;
}

/**
 * The "calendar" tier (tier 2 of 3): the middle tier docs/PROVIDERS.md's Flights Sky finding
 * adds. Spends a handful of cheap, broad requests — one per candidate per leg, each covering
 * a full year of daily prices (see `price-calendar.ts`'s module doc comment) — rather than
 * one expensive, narrow request per exact date (`widenSearch`, the confirm tier). Never
 * builds an `Itinerary`: a calendar answers "when/where should I go", not "book this exact
 * flight", so the result is the raw `PriceCalendarDay[]` data per candidate/leg/provider, for
 * the caller (the results list, issue #23, or the search form, issue #16) to render as a
 * calendar heatmap and let the traveller narrow from — and to hold onto and re-filter as that
 * narrowing changes, rather than calling this again for the same candidate.
 *
 * Does not yield a `SearchSnapshot` — its own `PriceCalendarOutcome` stream is a different
 * shape for a different question (raw calendar data, not itineraries), so it deliberately
 * doesn't try to force calendar results through the same snapshot type `runSearch`/
 * `widenSearch` use.
 *
 * Same non-negotiable rule as `WidenRequest`: `maxMeteredRequests` is required, with no
 * default, and this generator stops the moment it would be exceeded.
 */
export async function* widenWithPriceCalendar(
	query: SearchQuery,
	request: { candidateAirportCodes: readonly IataAirportCode[]; maxMeteredRequests: number },
	deps: SearchDependencies,
	options: SearchRunOptions = {}
): AsyncGenerator<PriceCalendarOutcome, void, void> {
	const signal = options.signal ?? new AbortController().signal;
	const allFlightProviders = deps.registry.ofKind('flight');
	yield* runPriceCalendarWiden(
		request.candidateAirportCodes,
		(code) => priceCalendarLegQueries(query, code, deps.currency),
		allFlightProviders,
		deps.keys,
		signal,
		request.maxMeteredRequests
	);
}
