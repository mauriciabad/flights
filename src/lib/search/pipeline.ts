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

import { findConnectionCandidates } from '../algorithm/connections';
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
	fetchBestTransfer,
	fetchConnectionResources,
	pickLandingToTransportTime
} from './resources';
import type {
	ConnectionCandidate,
	ItineraryResult,
	ItinerarySources,
	ProviderStatus,
	SearchDependencies,
	SearchQuery,
	SearchRunOptions,
	SearchSnapshot,
	SearchStage,
	WidenOption,
	WidenRequest
} from './types';

/** Resolves the two "outer" legs (leaving `originLocation`, arriving at
 * `destinationLocation`) once per search — they never depend on which connection candidate
 * ends up winning, so re-fetching them per candidate would just be the same query repeated. */
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
): Promise<{ transferToOriginAirport?: Transfer; transferToDestinationLocation?: Transfer }> {
	const [transferToOriginAirport, transferToDestinationLocationRaw] = await Promise.all([
		query.originLocation
			? fetchBestTransfer(
					{ from: query.originLocation.coordinates, to: originAirport.coordinates },
					transferProviders,
					keys,
					signal,
					sources,
					record
				)
			: Promise.resolve(undefined),
		query.destinationLocation
			? fetchBestTransfer(
					{ from: destinationAirport.coordinates, to: query.destinationLocation.coordinates },
					transferProviders,
					keys,
					signal,
					sources,
					record
				)
			: Promise.resolve(undefined)
	]);

	// The destination-location leg starts right after landing, same as transferToHotel does
	// for a connection — see resources.ts's own comment on why the buffer only applies to
	// legs that begin at a runway, never one ending at a departure gate.
	const transferToDestinationLocation = transferToDestinationLocationRaw
		? applyLandingBuffer(
				transferToDestinationLocationRaw,
				pickLandingToTransportTime(landingToTransportRules, destinationAirport.sizeClass),
				sources
			)
		: undefined;

	return { transferToOriginAirport, transferToDestinationLocation };
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

interface CandidateOutcome {
	candidate: ConnectionCandidate;
	itineraries: ItineraryResult[];
	/** Every `Stay` `fetchConnectionResources` found near this candidate, cheapest first,
	 * gender-eligibility not applied — issue #80's candidate list, carried through so a
	 * `SearchSnapshot` can keep it rather than only the pipeline's already-decided pick.
	 * Empty when the candidate produced no resources at all (nothing found, or every part
	 * failed to resolve). */
	stayCandidates: Stay[];
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
	const empty: CandidateOutcome = { candidate: input.candidate, itineraries: [], stayCandidates: [] };
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
	if (outboundOffers.length === 0 || onwardOffers.length === 0 || !resources) return empty;

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
			waitingTimeRules: input.query.waitingTimeRules
		});

		const results = rankItineraries(itineraries, input.airlinesToAvoid, input.weights).map(
			(score): ItineraryResult => ({ score, sources: sourcesForItinerary(score.itinerary, input.sources) })
		);
		return { candidate: input.candidate, itineraries: results, stayCandidates: resources.stayCandidates };
	} catch {
		// buildItineraries throws only for a currency mismatch across a candidate's own
		// parts (its own doc comment) — SearchDependencies.currency asks every provider for
		// the same one to make this rare. Degrading this one candidate, rather than the
		// whole search, is the same "one failure must never fail a search" contract this
		// pipeline holds for a provider error.
		return empty;
	}
}

/** Small closure factory shared by `runSearch` and `widenSearch` so both build a
 * `SearchSnapshot` the same way — bumping `sequence`, re-deriving `itineraryGroups` from
 * whatever has accumulated in `results` so far, and reading the live `providerStatus` and
 * `stayCandidatesByConnection` maps (issue #80: the latter is what keeps a connection's
 * full stay candidate list alive into the snapshot instead of collapsing to one pick). */
function makeSnapshotFn(
	results: ItineraryResult[],
	providerStatus: Map<ProviderId, ProviderStatus>,
	stayCandidatesByConnection: Map<IataAirportCode, Stay[]>
) {
	let sequence = 0;
	return function snapshot(stage: SearchStage, candidates: ConnectionCandidate[], done: boolean, widenOptions: WidenOption[] = []): SearchSnapshot {
		return {
			sequence: sequence++,
			stage,
			done,
			candidates,
			itineraryGroups: groupItineraryResults(results),
			providers: Object.fromEntries(providerStatus),
			widenOptions,
			stayCandidatesByConnection: Object.fromEntries(stayCandidatesByConnection)
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
 * `createCheapRoutesFlightProvider`) — then fetches flights, stays and transfers for them
 * from every currently-free provider (`providers/budget`'s `runCostAwareSearch` with no
 * `widenTo`, which is what guarantees a metered provider is never called), building and
 * scoring whatever itineraries the data supports.
 *
 * Yields a `SearchSnapshot` whose `stage` moves through `'candidates'` once ranking is done,
 * then `'stage1'` again for each candidate as its data finishes arriving (in completion
 * order — `race.ts`), then a final one with `done: true`.
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
	const snapshot = makeSnapshotFn(results, providerStatus, stayCandidatesByConnection);

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
		yield snapshot('done', candidates, true, widenOptions);
		return;
	}

	const { transferToOriginAirport, transferToDestinationLocation } = await fetchOuterTransfers(
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

	if (signal.aborted) {
		yield snapshot('done', candidates, true, widenOptions);
		return;
	}

	// No `widenTo`: only the free tier ever runs. This one line is what makes stage 1's "no
	// metered provider is ever called" guarantee hold, delegated entirely to
	// `providers/budget`'s own contract rather than a filter this file maintains itself.
	const fetchLegs: FetchLegsFn = async (outboundQuery, onwardQuery) => {
		const [outboundResult, onwardResult] = await Promise.all([
			runCostAwareSearch(flightCostAwareSources(allFlightProviders, outboundQuery, deps.keys, signal, sources, record)),
			runCostAwareSearch(flightCostAwareSources(allFlightProviders, onwardQuery, deps.keys, signal, sources, record))
		]);
		return { outboundOffers: flattenOk(outboundResult), onwardOffers: flattenOk(onwardResult) };
	};

	const tasks = candidates.map((candidate) =>
		processCandidate({
			candidate,
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
		})
	);

	for await (const outcome of raceToCompletion(tasks)) {
		if (signal.aborted) break;
		results.push(...outcome.itineraries);
		stayCandidatesByConnection.set(outcome.candidate.airportCode, outcome.stayCandidates);
		yield snapshot('stage1', candidates, false, widenOptions);
	}

	yield snapshot('done', candidates, true, widenOptions);
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
 * Scope note: only flight providers are widened to metered ones here. Stay and transfer
 * resources keep using free providers only, same as the free tier — Agoda's 500/month and
 * Booking's 50/month (docs/PROVIDERS.md) are generous enough that they don't need the same
 * one-request-per-date care Skyscanner does, and this keeps the budget-accounting logic
 * below (`cost-aware.ts`'s `pickMeteredWithinBudget`, a shared, exact ceiling) from having to
 * reason about more than one provider kind. A future issue can extend the same
 * `WidenRequest` shape to stay providers if that quota ever becomes the bottleneck instead.
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
	const snapshot = makeSnapshotFn(results, providerStatus, stayCandidatesByConnection);

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
			maxCandidates: options.maxCandidates,
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

	const { transferToOriginAirport, transferToDestinationLocation } = await fetchOuterTransfers(
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
