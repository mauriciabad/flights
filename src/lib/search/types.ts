/**
 * Issue #56: the search pipeline's public shape. Everything a caller (the search form,
 * issue #16; the results list, issue #23) needs to drive a search and render what comes
 * back, without either of them importing anything from `providers/`, `algorithm/`, or
 * `cache/` directly.
 *
 * Types only, same rule as `providers/types.ts` and `domain/index.ts`: this is the
 * chokepoint two UI issues get written against in parallel without seeing this file's
 * implementation, so it stays a stable contract. Runtime logic lives in `pipeline.ts` and
 * its siblings.
 *
 * ## Why an async generator of snapshots, not a rune-based store
 *
 * A `$state`-backed store would tie this module to Svelte and to being called from inside
 * component/effect context. `runSearch` and `widenSearch` below are plain async generator
 * functions instead: `for await (const snapshot of runSearch(...))` works identically from a
 * `.svelte.ts` module's `$effect`, a plain script, or a Vitest file with no network and no
 * Svelte runtime at all (see `pipeline.test.ts`). A component that wants rune-reactive state
 * wraps the loop in three lines (`let snapshot = $state(initial); for await (const s of
 * runSearch(...)) snapshot = s;`) — going the other direction, unwrapping a store back into a
 * plain async sequence a non-Svelte caller could consume, is not something either UI issue
 * should have to do. Reversing this later means rewriting both #16 and #23's consumption
 * code, so it is chosen deliberately here rather than by default.
 *
 * ## Why a cumulative snapshot, not an incremental delta
 *
 * Each yielded `SearchSnapshot` is the complete, current picture — candidates, itineraries,
 * provider status, all of it — not a patch to apply to the previous one. A consumer that
 * missed a tick (a paused tab, a slow re-render) never has to reconcile a partial diff: it
 * just renders whatever snapshot it has. The cost is copying a few arrays per tick, which is
 * cheap next to a network round trip and is the same trade `staleWhileRevalidate`
 * (`cache/stale-while-revalidate.ts`) already makes by yielding a whole value each time
 * rather than a diff.
 */

import type { ConnectionCandidate as AlgorithmConnectionCandidate } from '../algorithm/connections';
import type { ItineraryScore } from '../algorithm/score';
import type {
	Airport,
	Duration,
	IataAirportCode,
	IsoCalendarDate,
	IsoCurrencyCode,
	SearchQuery,
	Stay,
	Transfer,
	TransitPlanMoment
} from '../domain';
import type { ProviderRegistry } from '../providers/registry';
import type { AvailableKeys, ProviderError, ProviderId, ProviderKind, ProviderSource } from '../providers/types';
import type { TaxiFareEstimate } from '../providers/transfers/taxi-rate-table';
import type { ProviderAnswer } from './provenance';

export type { Airport };
export type ConnectionCandidate = AlgorithmConnectionCandidate;

/**
 * Everything the pipeline needs from the outside world, gathered in one place so
 * `runSearch`/`widenSearch` take exactly one options bag instead of a growing parameter
 * list. Not a class: a plain object a caller assembles once (typically at app start, from
 * `keyStore` and a module-level `ProviderRegistry`) and passes to every search.
 */
export interface SearchDependencies {
	registry: ProviderRegistry;
	keys: AvailableKeys;
	/**
	 * Resolves an IATA code to the dataset's full `Airport` record. Defaults to
	 * `getAirport` from `src/lib/data/airports.ts` (issue #11) when omitted — injectable so
	 * tests never trigger that module's dynamic `import()` of the 165KB generated dataset,
	 * and so a caller with a different airport source (e.g. a registered
	 * `AirportDataProvider`, once one exists) can supply it without this module knowing
	 * that interface exists.
	 */
	resolveAirport?: (iataCode: IataAirportCode) => Airport | undefined | Promise<Airport | undefined>;
	/**
	 * Currency every provider is asked to quote in. Every fixture and test in this codebase
	 * uses EUR (docs/PROVIDERS.md's own Travelpayouts sample: `"currency": "eur"`), and
	 * `SearchQuery` has no currency field of its own — the brief never asks the traveller to
	 * pick one, so callers pass `DEFAULT_SEARCH_CURRENCY` (`domain/money.ts`). Providers may
	 * still ignore this and answer in their own default currency; `buildItineraries` (issue
	 * #13) throws if two of a candidate's parts disagree, which `runSearch` catches
	 * per-candidate (see pipeline.ts) so one currency mismatch degrades that one candidate
	 * rather than the whole search.
	 *
	 * Issue #158: this is REQUIRED, and that is the whole fix. It was optional, every layer
	 * below threaded it correctly, and the one place that builds this object for a real
	 * search (`routes/results/+page.svelte`'s `deps()`) never set it — so it was `undefined`
	 * at the top of a chain that was otherwise right, Agoda was called with no
	 * `currency_id`, answered in USD, and the only candidate that managed to price a bed was
	 * the only one dropped. An optional field that every consumer needs is a field the next
	 * caller will forget; making it required moves that from a silent runtime degradation to
	 * a compile error at the construction site.
	 */
	currency: IsoCurrencyCode;
}

export interface SearchRunOptions {
	/** Cancels the search — see the module doc comment on cancellation semantics in
	 * pipeline.ts. Every provider call this pipeline makes carries this signal through. */
	signal?: AbortSignal;
	/** Forwarded to `findConnectionCandidates`. Default is that function's own
	 * `DEFAULT_MAX_CANDIDATES`. */
	maxCandidates?: number;
	/** Radius used for the near-connection stay search, brief line 76: "within 100km". */
	stayRadiusKm?: number;
}

/** One provider's running status for the lifetime of one search — enough for a settings-
 * adjacent panel to show "Booking.com: not subscribed" or a result card to badge "via
 * Skyscanner, 2 minutes ago" without either consumer re-deriving it from raw provider
 * calls. */
export interface ProviderStatus {
	providerId: ProviderId;
	kind: ProviderKind;
	label: string;
	/** Requests actually spent by this provider so far in this search, summed across every
	 * call made — the number a "you have N left this month" display would subtract from a
	 * quota. */
	requestsUsed: number;
	/** The most recent failure, if the provider's last call for this search did not
	 * succeed. Cleared on a subsequent success: a blip five seconds ago that then recovered
	 * is not still true "now" (AGENTS.md: "Say what you do not know rather than guessing",
	 * which cuts both ways — a resolved problem shouldn't be reported as ongoing either). */
	lastError?: ProviderError;
	/** ISO instant of the most recent successful response from this provider, for a
	 * "fetched 2 minutes ago" style badge. */
	lastFetchedAt?: string;
	/**
	 * Issue #130: calls that resolved `{ ok: true }` in this search, whatever they carried.
	 * Ryanair `404`s its routes endpoint for an airport outside its network and its adapter
	 * turns that into an ok, empty answer on purpose (`providers/flights/ryanair.ts`'s
	 * `isRouteNotFound`) — a real answer from a real request, and the exact case the results
	 * page used to render as "nothing has answered yet."
	 */
	okCalls: number;
	/** Of `okCalls`, how many carried at least one row. Zero while `okCalls` is above zero
	 * is the "answered with nothing" state: asked, answered, knows nothing about this
	 * query. See `providerAnswer` (`provenance.ts`) for the four-way reading a UI renders
	 * from these counters. */
	okCallsWithData: number;
}

/** Where one itinerary's numbers came from, keyed the same way as `Itinerary`'s own fields
 * so a UI can render "flight via Ryanair, stay via Agoda (12 min ago)" per part. Domain
 * types (`FlightOffer`, `Stay`, `Transfer`) carry no provenance of their own — see
 * `resources.ts`'s `SourceTracker` for how this gets attached without changing them. */
export interface ItinerarySources {
	outboundFlight: ProviderSource;
	onwardFlight: ProviderSource;
	stay?: ProviderSource;
	transferToHotel?: ProviderSource;
	transferToConnectionAirport?: ProviderSource;
	transferToOriginAirport?: ProviderSource;
	transferToDestinationLocation?: ProviderSource;
}

/** The four transfer legs of an itinerary, named the way `Itinerary` names them so a leg
 * identifier can be used as a key into either. */
export type TransitLegField =
	| 'transferToOriginAirport'
	| 'transferToHotel'
	| 'transferToConnectionAirport'
	| 'transferToDestinationLocation';

/**
 * Issue #135's honest-gap half: what the transit lookup for ONE leg of ONE itinerary
 * actually said.
 *
 * `SearchSnapshot.providers` (issue #130) already answers this search-wide, and cannot
 * answer it here: one Transitous call covering Barcelona and another covering Bucharest
 * collapse into a single provider row reading "answered", while the traveller looking at
 * the Bucharest leg is shown Walk 5h 16m, Drive 59m, Taxi 59m and no way to tell whether
 * there is no bus or whether nobody looked. So the states are #130's own `ProviderAnswer`
 * vocabulary, read by its own `providerAnswer()`, applied at leg granularity.
 */
export interface TransitLegAnswer {
	answer: ProviderAnswer;
	/** The journey moment the lookup was planned for. Present even when nothing was asked,
	 * so a UI can say what it *would* have asked about. */
	plannedFor?: TransitPlanMoment;
	/** The provider's own error, verbatim, when `answer` is `'failed'` — AGENTS.md: "show
	 * the error you got, never the one you assumed". */
	error?: ProviderError;
	/** Why nothing was asked, when `answer` is `'not-asked'`. `'no-provider'`: no usable
	 * transit adapter at all. `'budget-spent'`: this search had already used its ration
	 * (`transit-schedule.ts`'s `MAX_TRANSIT_LOOKUPS_PER_SEARCH`). */
	reason?: 'no-provider' | 'budget-spent';
	/**
	 * Issue #220: a route came back for this leg and `search/resources.ts` refused it as
	 * implausible for the distance. Only ever set alongside `answer: 'answered'`, and only
	 * when nothing survived the filter. A leg with one absurd option and one real bus has
	 * a real bus to show and nothing to explain.
	 *
	 * It exists so a card can print the observation rather than a conclusion. Without it
	 * the picker reads a leg with no transit row and says there is no service between these
	 * two points, which was not what happened: Transitous answered, with a 21h 27m journey
	 * across Europe to cover 9.7 km, and this app is what decided the traveller should not
	 * see it.
	 */
	withheld?: WithheldTransitRoute;
}

/** The shape of what issue #220's plausibility rule refused, in the numbers a traveller
 * can check: how many routes, the quickest of them, and the straight-line distance they
 * were measured against. */
export interface WithheldTransitRoute {
	count: number;
	quickest: Duration;
	straightLineKm: number;
}

export type TransitLegAnswers = Partial<Record<TransitLegField, TransitLegAnswer>>;

/** One scored itinerary plus where its numbers came from. */
export interface ItineraryResult {
	score: ItineraryScore;
	sources: ItinerarySources;
	/** Issue #135: per-leg transit lookups for THIS itinerary, planned for its own flight
	 * times. Absent on an itinerary that was never refined — a snapshot emitted mid-search,
	 * or one past the lookup budget. */
	transit?: TransitLegAnswers;
}

/**
 * Issue #114: one transfer leg's real alternatives — mirroring `stayCandidatesByConnection`'s
 * pattern (issue #80) for transfers instead of stays. `candidates` is every `Transfer` a
 * usable provider returned for this exact A-to-B, not only the one `resources.ts` picked to
 * build the itinerary with (an itinerary's own `transferToHotel`/etc. field is always one of
 * these, when any exist). `taxiFareEstimate` is OSRM's distance-based fare range for this
 * same pair, present only when a `taxi` candidate is among `candidates` — it is never folded
 * into any candidate's own `Transfer.price` (`providers/transfers/osrm.ts`'s own header
 * comment on why that separation is deliberate), so a component renders it as its own
 * clearly-labelled range instead of a quoted fare.
 */
export interface TransferLegOptions {
	candidates: Transfer[];
	taxiFareEstimate?: TaxiFareEstimate;
}

/** The two connection-side legs' alternatives for one candidate airport (connection airport
 * to hotel, and back) — `resources.ts`'s `fetchConnectionResources` produces one of these per
 * connection that resolves a stay. */
export interface ConnectionTransferOptions {
	transferToHotel: TransferLegOptions;
	transferToConnectionAirport: TransferLegOptions;
}

/** The two "outer" legs' alternatives (origin location to origin airport, destination airport
 * to destination location) — resolved once per search by `pipeline.ts`'s
 * `fetchOuterTransfers`, never per connection candidate, since neither leg depends on which
 * stopover wins. */
export interface OuterTransferOptions {
	transferToOriginAirport: TransferLegOptions;
	transferToDestinationLocation: TransferLegOptions;
}

/**
 * Every scored pairing through one connection airport, grouped — brief line 83: "Group
 * results into variants for same itinerary"; line 67: "user can see alternative flights for
 * same location with their price and difference from selected one, selecting updates ui."
 */
export interface ItineraryGroup {
	connectionAirportCode: IataAirportCode;
	/**
	 * The pairing this stopover's card opens on: the SHORTEST one it can do, at least one
	 * night whenever the city offers one (issue #224, `algorithm/stopover-length.ts`).
	 *
	 * It is not `variants[0]`, and that is the fix. `variants` is sorted by score, score
	 * pays for nights, so `variants[0]` was always this city's longest pairing: six nights
	 * beside Gatwick on a six-day search window, with the one-night trip present in
	 * `variants` and never shown. Every longer pairing is still here for the card's own
	 * nights control to move to.
	 */
	best: ItineraryResult;
	/** Sorted best score first, `best` included (usually not at index 0, see above).
	 * Length 1 is the common case (one viable flight pairing through this stopover); more
	 * than one means the traveller has a real choice of times, fares, or stopover
	 * lengths through the same city. */
	variants: ItineraryResult[];
}

/**
 * Where one `runSearch`/`widenSearch` call is in its own lifecycle — NOT which of the three
 * cost tiers is active (see `WidenTier` below for that, a separate axis entirely). Both
 * `runSearch` (free tier only) and `widenSearch` (confirm tier) progress through the same
 * four values: `'candidates'` once ranked, `'stage1'`/`'stage2'` respectively as each
 * candidate's data arrives, then `'done'`.
 */
export type SearchStage = 'candidates' | 'stage1' | 'stage2' | 'done';

/**
 * Mid-task finding (docs/PROVIDERS.md, "Flights Sky has a price calendar"): flight cost is
 * three tiers, not two, and a widen prompt has to say which one it's offering, because they
 * differ by an order of magnitude in both price and what they buy:
 *
 * - `'calendar'` — cheap and broad. One request answers "which dates are cheap" for a whole
 *   route over roughly a month (`price-calendar.ts`). Good for exploring where/when.
 * - `'confirm'` — expensive and narrow. One request per route per exact date
 *   (`cost-aware.ts` + `providers/budget`'s `estimateWidenCost`). Spent once the traveller
 *   has picked a specific candidate and date.
 *
 * Stay widening (Agoda/Booking) only ever needs `'confirm'` — those providers have no
 * calendar-shaped capability in this codebase, so this field is meaningful mainly for
 * `kind: 'flight'` options.
 */
export type WidenTier = 'calendar' | 'confirm';

/**
 * What spending a metered request would cost right now, without spending it — the answer
 * to "the caller can ask what widening would cost in requests" (issue #56). Computed for
 * every provider whose estimate is non-zero for the query at hand, usable or not: a
 * provider with `requiresKey: true` still gets listed, so a settings nudge ("add a
 * Skyscanner key to widen for ~2 requests") is possible before the user has configured
 * anything.
 */
export interface WidenOption {
	providerId: ProviderId;
	kind: ProviderKind;
	tier: WidenTier;
	label: string;
	/** Which connection candidate this estimate is for. Absent for an estimate that isn't
	 * tied to one candidate (there are none of those yet, but a future whole-search widen
	 * estimate would be modelled this way rather than by adding a second, parallel type). */
	candidateAirportCode?: IataAirportCode;
	/** Requests this provider's own cost-estimate method reports for the query described —
	 * `providers/budget`'s `estimateWidenCost` for `'confirm'`, `price-calendar.ts`'s
	 * `estimatePriceCalendarWidenCost` for `'calendar'`. */
	requests: number;
	/** True when this provider has no usable key yet, so `requests` is what widening would
	 * cost once one is added, not something `widenSearch` can spend right now. */
	requiresKey: boolean;
}

/**
 * The complete, current picture of one search, cumulative — see the module doc comment for
 * why this is a whole snapshot rather than a delta. `runSearch`/`widenSearch` (pipeline.ts)
 * yield a new one of these each time meaningful new information is available.
 */
export interface SearchSnapshot {
	/** Increases by one on every yield from the same search; a superseded search's snapshots
	 * can be told apart from a fresh one's without comparing object identity. Never
	 * meaningful to compare across two different `runSearch` calls. */
	sequence: number;
	stage: SearchStage;
	/** True on the last snapshot this search will ever produce — the generator returns
	 * immediately after (or, for the `for await` form, the loop simply ends). */
	done: boolean;
	/** Ranked stopover candidates from `findConnectionCandidates` (`algorithm/connections.ts`),
	 * present from the first snapshot onward. Useful on its own before any flight has
	 * resolved: a UI can show "considering Vienna, Milan, ..." immediately. */
	candidates: ConnectionCandidate[];
	/** Every itinerary built and scored so far, grouped by stopover and sorted best-first by
	 * group. Replaces the previous snapshot's value entirely (see module doc comment). */
	itineraryGroups: ItineraryGroup[];
	/** Per-provider status for every provider this search has called at least once, keyed
	 * by `ProviderId`. `Partial`, not total: most searches never call every registered
	 * adapter (a widen the user never opted into, a kind the query doesn't need), so a
	 * provider simply absent here has not been called yet. Called-and-empty is a present
	 * entry with `okCalls > 0` and `okCallsWithData === 0` (issue #130) — the two used to be
	 * indistinguishable, and the results page reported both as "nothing has answered yet." */
	providers: Partial<Record<ProviderId, ProviderStatus>>;
	/** What widening to a metered provider would cost, for the top-ranked candidates, at the
	 * query's full date range — see `WidenOption`. Narrows to a specific date only once the
	 * caller invokes `widenSearch` with one. */
	widenOptions: WidenOption[];
	/**
	 * Issue #80: every `Stay` `resources.ts` found near each connection candidate that has
	 * finished processing, cheapest first and gender-eligibility NOT applied, keyed by
	 * `ConnectionCandidate.airportCode`. `itineraryGroups` above only ever carries the one
	 * `Stay` the pipeline picked for each built `Itinerary` (`resources.ts`'s own fitness
	 * filter — never a `female-dorm` the party can't fully use); this field is what keeps
	 * the rest of what was found alive so a results page has real alternatives to hand
	 * issue #27's `StayPicker`, ineligible options included, instead of only the pipeline's
	 * already-decided pick. A connection with no entry here either hasn't finished yet or
	 * produced no stay resources at all.
	 */
	stayCandidatesByConnection: Record<IataAirportCode, Stay[]>;
	/**
	 * Issue #114: every transfer alternative found for each connection's two hotel-bound
	 * legs, keyed by `ConnectionCandidate.airportCode` — the transfer equivalent of
	 * `stayCandidatesByConnection` just above. A connection with no entry here either hasn't
	 * finished yet or resolved with no stay at all (issue #94: no stay means nowhere for
	 * these two legs to go, so there is nothing to offer alternatives for either).
	 */
	transferOptionsByConnection: Record<IataAirportCode, ConnectionTransferOptions>;
	/**
	 * Issue #114: alternatives for the two legs that never depend on which connection wins
	 * (origin location to origin airport, destination airport to destination location).
	 * Defaults to empty candidate lists before `runSearch`/`widenSearch` has resolved them
	 * (there is no "hasn't arrived yet" signal needed here the way there is for
	 * `transferOptionsByConnection`, since this is the same fixed value on every snapshot
	 * once computed, and there is nothing else it could be beforehand).
	 */
	outerTransferOptions: OuterTransferOptions;
	/**
	 * Issue #107: `true` once `runSearch` has confirmed, via a free keyless source
	 * (`algorithm/connections.ts`'s `hasKnownDirectRoute`), that the query's origin and
	 * destination already have a direct route between them. Only ever computed on the final
	 * `done` snapshot, and only when this search's own `itineraryGroups` came back empty.
	 * Checking it any earlier would mean spending a free-but-real network call on every
	 * search, most of which never need the answer. `false` on every other snapshot; a
	 * results UI should read it only once `done` is `true` and there is nothing to show,
	 * to tell "no stopover beats a direct flight" apart from "this search genuinely found
	 * nothing" (see `+page.svelte`'s empty state).
	 */
	hasDirectRoute: boolean;
}

/** The dates one leg may depart on. Both ends inclusive, and for the confirm tier they are
 * normally the same day. */
export interface DepartureWindow {
	earliest: IsoCalendarDate;
	latest: IsoCalendarDate;
}

/** One connection candidate the caller wants confirmed with a metered provider, for a
 * specific (ideally narrow — PROVIDERS.md: "Skyscanner is spent, deliberately and visibly,
 * on that one route and date") departure window on each of its two legs. Narrower than the
 * original `SearchQuery`'s whole range on purpose: `widenSearch` never re-derives a date
 * range on its own, so a caller cannot accidentally re-trigger the exact fan-out that burns
 * the monthly quota in one search (docs/PROVIDERS.md: "A ten-day window over two legs is 20
 * requests").
 *
 * Issue #244: this used to carry one window, for the outbound leg only, and `widenSearch`
 * narrowed only the two departure fields of the query it ran. The onward leg kept the
 * trip's whole arrival window, so a "confirm this one date" was eight requests on the
 * acceptance search rather than two. Build one with `confirmTargetFor`
 * (`confirm-target.ts`) rather than by hand: it is the same function the cost estimate
 * reads, which is what keeps the quoted price and the spent price the same number. */
export interface WidenTarget {
	candidateAirportCode: IataAirportCode;
	/** When the leg out of the query's origin airport departs. */
	outboundDeparture: DepartureWindow;
	/** When the leg out of the stopover departs. Not derivable from the outbound window:
	 * it depends on how many nights the traveller is staying, which only the itinerary in
	 * front of them knows. */
	onwardDeparture: DepartureWindow;
}

/**
 * Issue #56: "A search must never silently spend metered requests." This is the one call
 * that can — everything else in this module guarantees it never does — so it requires an
 * explicit, caller-supplied ceiling every time, exactly like `ProviderContext.maxRequests`
 * and `ConnectionGraphOptions.meteredRequestBudget` require one at their own layer. There is
 * no default.
 */
export interface WidenRequest {
	targets: WidenTarget[];
	/** Hard ceiling on total metered requests this one `widenSearch` call may spend, across
	 * every provider and target combined. Once reached, remaining providers/targets are
	 * skipped and reported as an ordinary partial result (`ProviderContext.maxRequests`'s own
	 * contract), never exceeded. */
	maxMeteredRequests: number;
}

export type { SearchQuery };
