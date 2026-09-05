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
 * ## Issue #124: the calendar tier auto-runs when free discovery finds nothing
 *
 * `runSearch` used to give up the moment `findConnectionCandidates` returned zero
 * candidates. That is exactly what happens for a route no free source has an edge for at
 * all (Ryanair doesn't fly it, the cheap-routes dataset has never cached it) — measured live
 * for BVC -> PFO. This pipeline now tries `calendar-discovery.ts`'s
 * `discoverCandidateViaCalendar` in that one case, before falling back to the empty-results
 * path: it prices a small bundled hub pool through Flights Sky's price calendar plus a
 * single-date confirm, both auto-run (no widen prompt) because both clear `isQuotaGenerous`
 * against that provider's own cap, the same "a key is the consent" rule #94 already applies
 * to stays. Sky Scrapper's per-date search stays behind the explicit widen flow untouched —
 * its own cap fails that same check.
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
import { pairConnections } from '../algorithm/build';
import type { ConnectionBlock } from '../algorithm/build';
import { discoverCandidateViaCalendar } from './calendar-discovery';
import { confirmTargetFor, narrowToConfirmTarget } from './confirm-target';
import { DEFAULT_SCORING_WEIGHTS, moneyCostOf, rankItineraries } from '../algorithm/score';
import type { ScoringWeights } from '../algorithm/score';
import { defaultStopover } from '../algorithm/stopover-length';
import { getAirport } from '../data/airports';
import {
	DEFAULT_LANDING_TO_TRANSPORT_RULES,
	groundTransferPoint,
	type Airport,
	type FlightOffer,
	type IataAirlineCode,
	type IataAirportCode,
	type Itinerary,
	type LandingToTransportRule,
	type Stay,
	type Transfer
} from '../domain';
import { createStayLookupBudget, runCostAwareSearch } from '../providers/budget';
import type { StayLookupBudget } from '../providers/budget';
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
	pickBestTransfer,
	pickLandingToTransportTime,
	ROAD_TRANSFER_MODES,
	withheldTransfersFor
} from './resources';
import { createTransitLookupBudget, fetchTransitSchedules } from './transit-schedule';
import type { TransitLookupBudget } from './transit-schedule';
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
 * Issue #114: also returns each leg's full candidate list (`TransferLegOptions`), the
 * outer-leg equivalent of `resources.ts`'s per-connection candidates. A `TransportPicker`
 * for "travel to the airport" or "travel to the destination" needs real alternatives
 * exactly the same way the connection-side pickers do. Since issue #249 each taxi in that
 * list carries its own rate-card estimate, which is why `countryCode` rides on the query
 * below.
 *
 * `currency` and `query.travellers` ride with it for the same reason, and their absence
 * here was a real hole. `resources.ts` has passed the currency since #339 and these two
 * legs never did, so the ride to the airport quoted the rate card's own currency under a
 * total in the traveller's, on the one leg of a trip the traveller definitely takes. #344
 * needs the party size on the same query, and a per-head share of the wrong currency would
 * have been worse than either half alone. */
async function fetchOuterTransfers(
	query: SearchQuery,
	originAirport: Airport,
	destinationAirport: Airport,
	transferProviders: readonly TransferProvider[],
	keys: AvailableKeys,
	signal: AbortSignal,
	landingToTransportRules: readonly LandingToTransportRule[],
	sources: SourceTracker,
	record: RecordProviderCall,
	currency: SearchDependencies['currency']
): Promise<{
	transferToOriginAirport?: Transfer;
	transferToDestinationLocation?: Transfer;
	transferToOriginAirportOptions: TransferLegOptions;
	transferToDestinationLocationOptions: TransferLegOptions;
}> {
	const [originOutcome, destinationOutcome] = await Promise.all([
		query.originLocation
			? fetchBestTransfer(
					// Roads only. This resolves once per search, before any flight is known,
					// so there is no journey moment to plan a timetable for — that happens
					// per itinerary in `transit-schedule.ts` (issue #135).
					{
						from: query.originLocation.coordinates,
						// Issue #341: the terminal, not the runway point. A traveller walks
						// to a door, and at Gatwick the two are 1.4 km apart with the runway
						// between them.
						to: groundTransferPoint(originAirport),
						modes: [...ROAD_TRANSFER_MODES],
						countryCode: originAirport.country.isoCode,
						displayCurrency: currency,
						travellers: query.travellers
					},
					transferProviders,
					keys,
					signal,
					sources,
					record
				)
			: undefined,
		query.destinationLocation
			? fetchBestTransfer(
					{
						from: groundTransferPoint(destinationAirport),
						to: query.destinationLocation.coordinates,
						modes: [...ROAD_TRANSFER_MODES],
						countryCode: destinationAirport.country.isoCode,
						displayCurrency: currency,
						travellers: query.travellers
					},
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

	return {
		transferToOriginAirport: originOutcome?.selected,
		transferToDestinationLocation,
		transferToOriginAirportOptions: query.originLocation
			? {
					candidates: originOutcome?.candidates ?? [],
					withheld: withheldTransfersFor(originOutcome)
				}
			: NO_TRANSFER_LEG_OPTIONS,
		transferToDestinationLocationOptions: query.destinationLocation
			? {
					candidates: destinationCandidates,
					withheld: withheldTransfersFor(destinationOutcome)
				}
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
	/** Issue #148: created ONCE per search and shared by every candidate, which is the
	 * entire point — a per-candidate budget would bound nothing, since the unbounded cost
	 * came from the candidate count itself. */
	stayLookupBudget: StayLookupBudget;
	/** Issue #135: this search's shared ration of Transitous `/plan` lookups, created once
	 * per search for the same reason `stayLookupBudget` is — a per-candidate bound bounds
	 * nothing when the candidate count is what grows. */
	transitLookupBudget: TransitLookupBudget;
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
	/** Issue #324: why this candidate produced no itinerary. Absent whenever `itineraries`
	 * carries one, and absent on an aborted search, where nothing was decided and saying
	 * "nothing flies here" would be this app reporting its own cancellation as a fact about
	 * the route. */
	block?: ConnectionBlock;
}

/**
 * Everything issue #56's algorithm steps 2-5 do for one connection candidate: fetch both
 * legs' flights, then the candidate's stay and transfer resources, assemble whatever
 * itineraries that data supports, score them, and attach provenance. Returns an empty list,
 * never a throw, for every way a candidate can fail to pan out (no airport record, no
 * flights either direction, no stay reachable, or a currency mismatch `buildItineraries`
 * itself refuses to total) — "one provider failing must never fail a search" applies at the
 * granularity of one candidate here, not just one provider.
 *
 * ## Why the two fetches are sequential
 *
 * They used to run in one `Promise.all`, on the reasoning that neither depends on the other.
 * They do not, but the *candidate* depends on the flights: two lines below, a candidate with
 * no offers on either leg is dropped, and everything the resource fetch spent on it is
 * spent on a stopover nobody will ever be shown.
 *
 * Measured on `/results/?dep=2026-10-01&arr=2026-10-20&from=BCN&to=TLL` with every keyless
 * provider answering from a fixture, the search `provider-answered-nothing.spec.ts` uses
 * precisely because it finds nothing: 28 OSRM route requests, all 28 distinct, eleven
 * candidate cities routed in both directions, and not one itinerary at the end of it. The
 * same fan-out spends Hostelworld lookups, and with a key configured it spends Booking and
 * Agoda ones, which is the owner's own metered quota (AGENTS.md, "The owner's quota is real
 * money he told us he would not spend").
 *
 * The cost of the swap is that a candidate which does have flights starts its resource
 * lookups after them rather than alongside. That is the right way round: this app asks a
 * volunteer-run router and a metered hotel API about a place only once it knows the
 * traveller can get there.
 */
async function processCandidate(input: ProcessCandidateInput): Promise<CandidateOutcome> {
	const empty: CandidateOutcome = {
		candidate: input.candidate,
		itineraries: [],
		stayCandidates: [],
		transferOptions: NO_CONNECTION_TRANSFER_OPTIONS
	};
	/** Issue #324: the same empty outcome, carrying the rule that emptied it. Every reason
	 * below is one this function already decided; none of them is re-derived downstream. */
	const blockedBy = (block: ConnectionBlock): CandidateOutcome => ({ ...empty, block });

	if (input.signal.aborted) return empty;

	const connectionAirport = await input.resolveAirport(input.candidate.airportCode);
	// No dataset entry — nowhere to send the traveller.
	if (!connectionAirport) return blockedBy({ reason: 'airport-unknown' });

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

	const { outboundOffers, onwardOffers } = await input.fetchLegs(outboundQuery, onwardQuery);

	if (input.signal.aborted) return empty;
	// Nothing flies this way, so nothing below is worth asking about. See this function's
	// own comment for what asking anyway cost.
	if (outboundOffers.length === 0) return blockedBy({ reason: 'no-outbound-flight' });
	if (onwardOffers.length === 0) return blockedBy({ reason: 'no-onward-flight' });

	// Issue #94: `resources` itself is never `undefined` — a missing stay degrades
	// `resources.stay` to `undefined` rather than dropping the candidate, so having no
	// flights, checked above, is the only thing that still empties one outright.
	const resources = await fetchConnectionResources({
		connectionCoordinates: groundTransferPoint(connectionAirport),
		connectionAirportSize: connectionAirport.sizeClass,
		connectionCountryCode: connectionAirport.country.isoCode,
		// Issue #161: `undefined` for every airport without a hand-checked city point
		// (issue #162), which leaves the two in-city legs exactly as empty as before.
		connectionCityCentre: connectionAirport.city.coordinates,
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
		females: input.query.females,
		currency: input.currency,
		stayLookupBudget: input.stayLookupBudget
	});

	if (input.signal.aborted) return empty;

	try {
		const { itineraries, blocked } = pairConnections({
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

		const scored = rankItineraries(itineraries, input.airlinesToAvoid, input.weights);

		// Issue #135. Everything above this line was fetched before either flight was known,
		// so none of it could ask a timetable the right question. Now both flights are on the
		// itinerary, so the check-in deadline and the landing moment are real times, and
		// public transport can finally be asked about the journey the traveller is actually
		// taking rather than about the minute the search ran.
		//
		// Only this candidate's best pairing is refined. It is the one the result card shows
		// and the one a detail view opens, and refining every variant would multiply requests
		// to a volunteer-run service by however many fares the flight providers happened to
		// return. The other variants keep their road-mode transfers, which is also what
		// happens today when a traveller swaps flights in the picker.
		//
		// Issue #224, then #364: "the one the result card shows" is the CHEAPEST stopover
		// through this city, ties to the shortest stay, not the top-scoring pairing.
		// `groupItineraryResults` picks the card's itinerary with the same `defaultStopover`
		// rule, so both agree on which trip is worth the one timetable lookup this candidate
		// gets. Spending it on the longest pairing would have bought a bus schedule for a
		// trip nobody is shown. Same cost: one refinement per candidate, before and after.
		const cardPairing = defaultStopover(
			scored,
			(score) => score.itinerary.nightsInConnection,
			moneyCostOf
		);
		const refined = cardPairing ? await fetchTransitSchedules({
			itinerary: cardPairing.itinerary,
			connectionCoordinates: groundTransferPoint(connectionAirport),
			connectionLandingBuffer: pickLandingToTransportTime(input.landingToTransportRules, connectionAirport.sizeClass),
			destinationLandingBuffer: pickLandingToTransportTime(input.landingToTransportRules, input.destinationAirport.sizeClass),
			transferProviders: input.transferProviders,
			keys: input.keys,
			signal: input.signal,
			sources: input.sources,
			record: input.record,
			budget: input.transitLookupBudget,
			minLayoverTime: input.query.minLayoverTime
		}) : undefined;

		// Re-ranked rather than slotted back in where it was: swapping a two-hour walk for a
		// forty-minute night bus changes this itinerary's total time, which is one of the
		// things `rankItineraries` scores on. Keeping the old order would show a stale one.
		//
		// The refined pairing is substituted by identity rather than by index. It is no
		// longer `scored[0]` (issue #224 refines the shortest stopover, not the top score),
		// and slicing off index 0 would have dropped the top-scoring variant and duplicated
		// the refined one.
		const finalItineraries = refined
			? scored.map((score) =>
					score.itinerary === cardPairing?.itinerary ? refined.itinerary : score.itinerary
				)
			: scored.map((score) => score.itinerary);
		const results = rankItineraries(finalItineraries, input.airlinesToAvoid, input.weights).map(
			(score): ItineraryResult => ({
				score,
				sources: sourcesForItinerary(score.itinerary, input.sources),
				transit: refined && score.itinerary === refined.itinerary ? refined.answers : undefined
			})
		);
		return {
			candidate: input.candidate,
			itineraries: results,
			block: blocked[input.candidate.airportCode],
			stayCandidates: resources.stayCandidates,
			// Deliberately NOT widened with the transit transfers `fetchTransitSchedules` just
			// found. These lists are shared by every variant in the group and, for the outer
			// legs, by every group in the search, while a timetable is only true for the one
			// itinerary it was planned for. Offering it as an "alternative" elsewhere would
			// put a schedule for somebody else's flight back on screen, which is the defect.
			// The refined itinerary carries its own transit transfer, and `TransportPicker`
			// always renders the itinerary's current transfer whether or not it is in this
			// list.
			transferOptions: {
				transferToHotel: {
					candidates: resources.transferToHotelCandidates,
					withheld: resources.transferToHotelWithheld
				},
				transferToConnectionAirport: {
					candidates: resources.transferToConnectionAirportCandidates,
					withheld: resources.transferToConnectionAirportWithheld
				}
			}
		};
	} catch {
		// buildItineraries throws only for a currency mismatch across a candidate's own
		// parts (its own doc comment) — SearchDependencies.currency asks every provider for
		// the same one to make this rare. Degrading this one candidate, rather than the
		// whole search, is the same "one failure must never fail a search" contract this
		// pipeline holds for a provider error.
		return blockedBy({ reason: 'prices-disagree' });
	}
}

/**
 * Issue #324: keeps the map of refusals in step with the map of results, in the one place
 * both `runSearch` and `widenSearch` call.
 *
 * The delete matters as much as the set. A widen can price a candidate the free tier could
 * not, and a connection that has just produced its first itinerary must stop carrying the
 * sentence saying it produced none, or the map draws a route and captions it "nothing flies
 * onward from here".
 */
function recordBlock(blockedConnections: Map<IataAirportCode, ConnectionBlock>, outcome: CandidateOutcome): void {
	if (outcome.itineraries.length > 0 || !outcome.block) blockedConnections.delete(outcome.candidate.airportCode);
	else blockedConnections.set(outcome.candidate.airportCode, outcome.block);
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
 * up the new value, the same way the maps below are read live rather than passed by value.
 * `confirmedBeyondCapRef` (issue #350) is the same kind of holder, written once when
 * candidate discovery reports what its cap dropped. */
function makeSnapshotFn(
	results: ItineraryResult[],
	providerStatus: Map<ProviderId, ProviderStatus>,
	stayCandidatesByConnection: Map<IataAirportCode, Stay[]>,
	transferOptionsByConnection: Map<IataAirportCode, ConnectionTransferOptions>,
	blockedConnections: Map<IataAirportCode, ConnectionBlock>,
	outerTransferOptionsRef: { current: OuterTransferOptions },
	confirmedBeyondCapRef: { current: IataAirportCode[] }
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
			// Issue #350: subtracted here rather than trusted from the caller. The #115
			// fallback sweep re-runs discovery at a larger cap, so a candidate the primary
			// call dropped can be on screen by the time this snapshot is built, and a page
			// reading "8 considered and 2 more we did not price" about two of those eight is
			// worse than the silence this replaced. Making the invariant hold where the
			// snapshot is assembled means it cannot depend on which discovery call ran last.
			confirmedBeyondCap: confirmedBeyondCapRef.current.filter(
				(code) => !candidates.some((candidate) => candidate.airportCode === code)
			),
			itineraryGroups: groupItineraryResults(results),
			providers: Object.fromEntries(providerStatus),
			widenOptions,
			stayCandidatesByConnection: Object.fromEntries(stayCandidatesByConnection),
			transferOptionsByConnection: Object.fromEntries(transferOptionsByConnection),
			blockedConnections: Object.fromEntries(blockedConnections),
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
 *
 * Priced against the query `widenSearch` will really run for this candidate, not against
 * the search's own date range (issue #244). Those were different queries, and the gap
 * between them is what made the row unpressable: the estimate spanned the whole range at
 * one request per date, while the spend narrows to the single date on screen. The estimate
 * needs no itinerary to be exact, because the number of dates is fixed by the tier rather
 * than by which dates they are — see `confirmTargetFor`.
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
		const confirmQuery = narrowToConfirmTarget(query, confirmTargetFor(candidate.airportCode, query));
		const outboundQuery = outboundLegQuery(confirmQuery, query.originAirport, candidate.airportCode, currency);
		const onwardQuery = onwardLegQuery(confirmQuery, candidate.airportCode, query.destinationAirport, currency);
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
	const blockedConnections = new Map<IataAirportCode, ConnectionBlock>();
	const outerTransferOptionsRef = { current: NO_OUTER_TRANSFER_OPTIONS };
	const confirmedBeyondCapRef = { current: [] as IataAirportCode[] };
	const reportBeyondCap = (beyondCap: readonly ConnectionCandidate[]) => {
		confirmedBeyondCapRef.current = beyondCap.map((candidate) => candidate.airportCode);
	};
	const snapshot = makeSnapshotFn(
		results,
		providerStatus,
		stayCandidatesByConnection,
		transferOptionsByConnection,
		blockedConnections,
		outerTransferOptionsRef,
		confirmedBeyondCapRef
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
					{ flightProviders: allFlightProviders, providerKeys: deps.keys, signal, onProviderResult: record }
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
			// Issue #130: candidate discovery is the only provider call many searches ever
			// make, so without this the status panel had nothing to report at all.
			onProviderResult: record,
			maxCandidates: options.maxCandidates,
			// Issue #350: what this cap threw away, so the page can say it found more than it
			// is pricing. Every discovery call in this file reports, and the last one to run
			// wins, because the candidates on screen are the ones IT returned. The snapshot
			// subtracts anything a later call went on to keep.
			onCandidatesBeyondCap: reportBeyondCap,
			signal
			// meteredRequestBudget intentionally omitted (default 0): this is the line that
			// guarantees stage 1 spends nothing, even as connections.ts's own last-resort
			// fallback for an origin with zero free edges (its own doc comment on the field).
		}
	);

	let widenOptions = widenOptionsForCandidates(candidates, query, allFlightProviders, deps.keys, currency);
	yield snapshot('candidates', candidates, false, widenOptions);

	// Issue #124: every free source came back with nothing to build on — measured live for
	// BVC -> PFO, where Ryanair doesn't serve Cabo Verde and the cheap-routes dataset has no
	// edge into either side of the pair. Before giving up, try Flights Sky's price calendar
	// against a small bundled hub pool (`calendar-discovery.ts`) — the one remaining source
	// that can price a route those two can't see at all, auto-run (no widen prompt) the same
	// way #94 auto-runs a cheap-enough stay provider once a key is present, gated by the same
	// `isQuotaGenerous` check. Never attempted when free candidates already exist: a
	// well-served route never pays for this, and `findConnectionCandidates`'s own detour/size
	// ranking is strictly better data when it has anything to rank at all.
	let discoveredCandidate: ConnectionCandidate | undefined;
	let discoveredOffers: { outboundOffers: FlightOffer[]; onwardOffers: FlightOffer[] } | undefined;
	let candidatesToRun = candidates;

	if (!signal.aborted && candidates.length === 0) {
		const discovery = await discoverCandidateViaCalendar({
			originAirport: query.originAirport,
			destinationAirport: query.destinationAirport,
			outboundWindow: {
				earliestDeparture: query.soonestDeparture,
				latestDeparture: query.latestDeparture ?? query.latestArrival
			},
			onwardWindow: {
				earliestDeparture: query.soonestArrival ?? query.soonestDeparture,
				latestDeparture: query.latestArrival
			},
			forbiddenConnectionAirports: query.forbiddenConnectionAirports,
			forbiddenConnectionCountries: query.forbiddenConnectionCountries,
			allowedConnectionAirports: query.allowedConnectionAirports,
			resolveAirportInfo: airportLookupFrom(resolveAirport),
			flightProviders: allFlightProviders,
			keys: deps.keys,
			signal,
			currency,
			travellers: query.travellers,
			sources,
			record
		});
		if (discovery) {
			discoveredCandidate = discovery.candidate;
			discoveredOffers = { outboundOffers: discovery.outboundOffers, onwardOffers: discovery.onwardOffers };
			candidatesToRun = [discovery.candidate];
			widenOptions = widenOptionsForCandidates(candidatesToRun, query, allFlightProviders, deps.keys, currency);
			yield snapshot('candidates', candidatesToRun, false, widenOptions);
		}
	}

	if (signal.aborted || candidatesToRun.length === 0) {
		// No stopover candidate survived ranking at all, the common shape for a well-served
		// direct route (any detour through a third city fails `maxDetourRatio` outright), so
		// this is exactly the case the empty-results UI needs `hasDirectRoute` for.
		const hasDirectRoute = candidatesToRun.length === 0 ? await checkDirectRoute() : false;
		yield snapshot('done', candidatesToRun, true, widenOptions, hasDirectRoute);
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
		record,
		currency
	);
	outerTransferOptionsRef.current = {
		transferToOriginAirport: transferToOriginAirportOptions,
		transferToDestinationLocation: transferToDestinationLocationOptions
	};

	if (signal.aborted) {
		yield snapshot('done', candidatesToRun, true, widenOptions);
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
		// Issue #148: one ration for the whole search, deliberately created out here rather
		// than inside `buildCandidateTasks`. Both the primary batch below and the fallback
		// sweep further down draw from THIS object, which is what stops the 24-candidate
		// sweep multiplying stay spend by four over the 6-candidate batch — the fallback
		// path inherits an already-partly-spent budget rather than a fresh one.
		stayLookupBudget: createStayLookupBudget(),
		// Issue #135: one ration for the whole search, same reasoning as the line above.
		// Transitous is free, so this is not about money — it is about not turning one click
		// into a dozen requests against a volunteer-run server.
		//
		// Issue #267: the caller may hold it, because the search is no longer the only thing
		// that spends timetable lookups. The detail panel's on-demand check draws from this
		// same object, so twelve is twelve however it is spent.
		transitLookupBudget: options.transitLookupBudget ?? createTransitLookupBudget(),
		transferToOriginAirport,
		transferToDestinationLocation,
		sources,
		record
	};

	// The calendar-discovered candidate (issue #124), if any, already has real, confirmed
	// offers in hand — fetching it again through the free-tier-only `fetchLegs` above would
	// find nothing (that path is exactly what already failed to see this candidate) and
	// would also be unsafe: `algorithm/connections.ts` never ranked it, so it has no free
	// source vouching for either leg. Every other candidate in this batch uses the shared
	// `fetchLegs` exactly as before.
	const primaryCandidateTasks = candidatesToRun.map((candidate) =>
		processCandidate(
			discoveredCandidate && discoveredOffers && candidate.airportCode === discoveredCandidate.airportCode
				? { ...candidateInputBase, candidate, fetchLegs: async () => discoveredOffers! }
				: { ...candidateInputBase, candidate }
		)
	);

	for await (const outcome of raceToCompletion(primaryCandidateTasks)) {
		if (signal.aborted) break;
		results.push(...outcome.itineraries);
		stayCandidatesByConnection.set(outcome.candidate.airportCode, outcome.stayCandidates);
		transferOptionsByConnection.set(outcome.candidate.airportCode, outcome.transferOptions);
		recordBlock(blockedConnections, outcome);
		yield snapshot('stage1', candidatesToRun, false, widenOptions);
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
	let finalCandidates = candidatesToRun;
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
				onProviderResult: record,
				maxCandidates: FALLBACK_MAX_CANDIDATES,
				onCandidatesBeyondCap: reportBeyondCap,
				signal
				// meteredRequestBudget intentionally omitted (default 0), same as the primary
				// call above — re-deriving a larger slice of the same free ranking spends
				// nothing metered no matter how many candidates it returns.
			}
		);
		const alreadyTried = new Set(candidatesToRun.map((candidate) => candidate.airportCode));
		const fallbackCandidates = expandedCandidates.filter((candidate) => !alreadyTried.has(candidate.airportCode));

		if (!signal.aborted && fallbackCandidates.length > 0) {
			finalCandidates = [...candidatesToRun, ...fallbackCandidates];
			finalWidenOptions = widenOptionsForCandidates(finalCandidates, query, allFlightProviders, deps.keys, currency);
			yield snapshot('stage1', finalCandidates, false, finalWidenOptions);

			for await (const outcome of raceToCompletion(buildCandidateTasks(fallbackCandidates, candidateInputBase))) {
				if (signal.aborted) break;
				results.push(...outcome.itineraries);
				stayCandidatesByConnection.set(outcome.candidate.airportCode, outcome.stayCandidates);
				transferOptionsByConnection.set(outcome.candidate.airportCode, outcome.transferOptions);
				recordBlock(blockedConnections, outcome);
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
	// Issue #148: one ration for this whole confirm run, shared across every target the
	// traveller confirmed — see its use below for why the confirm tier is rationed too.
	const stayLookupBudget = createStayLookupBudget();
	// Issue #135: same per-search ration for the confirm tier as the free one. Issue #267:
	// the caller may hold it, so a widen and the detail panel's on-demand check draw from
	// one object rather than one each.
	const transitLookupBudget = options.transitLookupBudget ?? createTransitLookupBudget();

	const providerStatus = new Map<ProviderId, ProviderStatus>();
	const record: RecordProviderCall = (provider, result) => recordProviderResult(providerStatus, provider, result);
	const sources = new SourceTracker();
	const results: ItineraryResult[] = [];
	const stayCandidatesByConnection = new Map<IataAirportCode, Stay[]>();
	const transferOptionsByConnection = new Map<IataAirportCode, ConnectionTransferOptions>();
	const blockedConnections = new Map<IataAirportCode, ConnectionBlock>();
	const outerTransferOptionsRef = { current: NO_OUTER_TRANSFER_OPTIONS };
	const confirmedBeyondCapRef = { current: [] as IataAirportCode[] };
	const reportBeyondCap = (beyondCap: readonly ConnectionCandidate[]) => {
		confirmedBeyondCapRef.current = beyondCap.map((candidate) => candidate.airportCode);
	};
	const snapshot = makeSnapshotFn(
		results,
		providerStatus,
		stayCandidatesByConnection,
		transferOptionsByConnection,
		blockedConnections,
		outerTransferOptionsRef,
		confirmedBeyondCapRef
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
			onProviderResult: record,
			onCandidatesBeyondCap: reportBeyondCap,
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
		record,
		currency
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

		// Narrowed to exactly the windows the traveller confirmed for this candidate — never
		// the original query's full range, which is what keeps this call cheap
		// (docs/PROVIDERS.md: "Skyscanner is spent ... on that one route and date"). Shared
		// with `confirmWidenOptions` above so the quote and the spend are one number.
		const narrowedQuery = narrowToConfirmTarget(query, target);

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
			// Issue #148: the confirm tier is the one place a traveller has explicitly agreed
			// to spend, but "agreed to spend" is not "agreed to spend without limit" — this
			// gets the same per-search ration as the free tier so one confirmation cannot
			// empty a month either.
			stayLookupBudget,
			transitLookupBudget,
			transferToOriginAirport,
			transferToDestinationLocation,
			sources,
			record
		});

		results.push(...outcome.itineraries);
		stayCandidatesByConnection.set(outcome.candidate.airportCode, outcome.stayCandidates);
		transferOptionsByConnection.set(outcome.candidate.airportCode, outcome.transferOptions);
		recordBlock(blockedConnections, outcome);
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
