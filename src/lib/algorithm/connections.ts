/**
 * Issue #12: the connection graph.
 *
 * Given an origin A and a destination B with no affordable direct flight, this finds
 * candidate stopover cities C where a direct A -> C and a direct C -> B both plausibly
 * exist, and ranks them so the *best* candidates get priced first.
 *
 * Why ranking has to happen here, before anything downstream spends a request: Skyscanner's
 * free tier is 20 requests a month, hard limit (docs/PROVIDERS.md), and every surviving
 * candidate this module returns costs two fare searches later in the pipeline (build.ts /
 * score.ts, issues #13 and #14 — neither owned by this file). A naive search that tried
 * every airport on earth would exhaust a month's quota on its first run. This module is
 * what makes the difference between an app that answers a question and one that dies on
 * search one, so it spends nothing metered itself unless a caller-supplied `FlightProvider`
 * turns out to actually be metered, and even then only as a last resort for candidates the
 * caller named explicitly.
 *
 * Sources, cheapest first (brief line 73: "Get flight connections (flightconnections.com
 * or similar)"):
 *   1. Real `FlightProvider` adapters (issue #2, `../providers/types`), passed in via
 *      `options.flightProviders` — Ryanair's keyless route graph is the intended one, once
 *      an adapter implementing `FlightProvider` for it exists (none is on `main` as of this
 *      writing; only the interface is). Each is classified free-to-call or metered by
 *      probing `estimateSearchOffersCost` — see `isFreeProvider` — rather than the caller
 *      having to say which is which.
 *   2. `FALLBACK_ROUTES` (./connections-fallback-data.ts), a small bundled table, always
 *      included so first paint and offline both produce a plausible answer.
 *   3. Whichever of `flightProviders` classified as metered, used only as a last resort:
 *      never for broad discovery, only for candidates the caller explicitly allow-listed,
 *      and budgeted by `meteredRequestBudget`. The two places this module would ever spend
 *      one are marked "SPENDS A METERED REQUEST" below.
 *
 * A provider's `{ ok: false }` result (a network error, a 429, a missing key) is never
 * thrown or allowed to fail the whole search — it's treated as "this source doesn't know,"
 * exactly like an empty answer, and the algorithm falls through to whatever source runs
 * next (ultimately the bundled table for the free path). Same contract every other caller
 * of a `ProviderResult` in this codebase follows.
 *
 * ## Where a candidate comes from, and what this module cannot propose
 *
 * Every candidate is an airport the ORIGIN is known to fly to. That set is the origin's own
 * direct-destination list, which is what a provider answers, unioned with a vendored
 * all-carrier route graph that ships with the app (`../data/direct-routes`, issue #361).
 * Nothing else proposes, and the search then asks each candidate whether it flies on to the
 * destination.
 *
 * The graph exists because the provider's list is a sample. Issue #350 measured the gap:
 * `EMA` (Nottingham / East Midlands) is one of flightconnections.com's ten stopovers for
 * `BVC -> PFO` and Kiwi sells both of its legs, yet Boa Vista's
 * `onewayOnePerCityItineraries` answer is 20 price-sorted rows that do not name it. No
 * post-processing recovers a row that is not there, so the row comes from somewhere else.
 *
 * Enumerating from the DESTINATION's inbound side as well was issue #380, and it is not
 * here because it was measured and does not pay. Such a candidate arrives with `C -> B`
 * known and `A -> C` unknown, so proving it costs a request, and the budget it draws on is
 * the same eighteen ranked positions the origin's own candidates use. Over 300 routes it
 * spent 37% more keyless requests and cost three routes a confirmed stopover, two of them
 * their only one. Giving the origin's candidates first claim on the budget removed the
 * losses and left the additions inert, because a route with eighteen origin-side candidates
 * never reaches the rest. Reproduce it with `tools/probe-candidate-sources.mjs` against
 * this file and against a tree that proposes both ways.
 *
 * So the limit is the origin's known out-degree, plus the graph's node set, which is bounded
 * by the codes the other bundled sources already name: the graph adds EDGES and never
 * AIRPORTS, and an airport no bundled source has ever named cannot be a stopover. Every
 * source here is a floor, never a ceiling, and `confirmsRoute` returning `false` means "this
 * table does not say so", never "no such route".
 *
 * Written down here rather than left implicit, because the next reader's question is why a
 * route they can see on a third-party map does or does not appear in this app's results.
 */

import type {
	AirportSizeClass,
	Coordinates,
	IataAirportCode,
	IsoCountryCode,
	SearchQuery
} from '../domain';
import { getAirport } from '../data/airports';
import { hasDirectRoute, loadBundledDirectRoutes, neighboursOf } from '../data/direct-routes';
import { loadBundledRyanairNetwork } from '../data/ryanair-network';
import type { AvailableKeys, FlightProvider, FlightSearchQuery, ProviderResult } from '../providers/types';
import { contextFor } from '../providers/registry';
import { FALLBACK_AIRPORTS, FALLBACK_ROUTES } from './connections-fallback-data';

/**
 * This module's own internal shape for "given an airport, which airports does it fly to
 * directly" — what the bundled fallback table looks like once wrapped, and what a real
 * `FlightProvider` looks like once adapted (see `sourceFromProvider`). Kept distinct from
 * `FlightProvider` itself because the fallback table isn't one (no key fields, no health
 * check, no cost estimate — it's a plain lookup table) and doesn't need to pretend to be.
 */
interface DirectDestinationSource {
	/** Stable id, surfaced on each candidate's `confirmedBy` so a wrong candidate can be
	 * traced back to the source that vouched for it — a `FlightProvider`'s own `id` for an
	 * adapted one, `'fallback-table'` for the bundled table. */
	readonly id: string;
	getDirectDestinations(iataCode: IataAirportCode): Promise<IataAirportCode[]>;
	/**
	 * Issue #340: "do you have this exact pair", for a source that can answer it better
	 * than by listing everywhere `origin` flies and checking.
	 *
	 * `true` is a confirmation. Anything else means "not confirmed by me" and the caller
	 * moves to the next source — never "no such route", because none of these sources is in
	 * a position to say that. Omitted entirely by a source whose list already IS its whole
	 * network, where membership and this question are the same thing.
	 */
	confirmsRoute?(origin: IataAirportCode, destination: IataAirportCode): Promise<boolean>;
}

/** What this module needs to rank a candidate: where it is, how big it is, and which
 * country it's in (for the forbidden-country filter). A subset of the domain `Airport`
 * shape, so both the real airport dataset (issue #11, `../data/airports`) and a
 * caller-supplied override lookup satisfy it with `{ coordinates: a.coordinates, sizeClass:
 * a.sizeClass, countryCode: a.country.isoCode }`. */
export interface ConnectionAirportInfo {
	coordinates: Coordinates;
	sizeClass: AirportSizeClass;
	countryCode: IsoCountryCode;
}

/** May return synchronously or asynchronously. `undefined` means "this lookup has no
 * record for that code", never a throw — see the graceful-degradation notes on
 * `scoreCandidate` below. Consulted before the real airport dataset (`../data/airports`),
 * so a caller can override specific codes (mainly useful for tests) without that dataset
 * ever being consulted for them. */
export type AirportLookup = (
	iataCode: IataAirportCode
) => ConnectionAirportInfo | undefined | Promise<ConnectionAirportInfo | undefined>;

/** Score components before weighting, each in `[0, 1]` (`detour` is `null` when geography
 * for A, B, or the candidate is unknown to every lookup tier — see `scoreCandidate`).
 * Exposed mainly so a UI or a test can explain *why* a candidate ranked where it did,
 * rather than trusting a single opaque number. */
export interface ConnectionScoreBreakdown {
	sizeClass: number;
	detour: number | null;
	/** How evenly this candidate splits the journey, `null` when geography for A, B or C is
	 * unknown. Issue #340 — see `CandidateGeographyScore.balance`. */
	balance: number | null;
}

export interface ConnectionCandidate {
	airportCode: IataAirportCode;
	/** Weighted sum of `breakdown`'s components, `[0, 1]`. Candidates are sorted by this,
	 * descending. */
	score: number;
	breakdown: ConnectionScoreBreakdown;
	/** Which source confirmed each leg — a `FlightProvider`'s `id`, or `'fallback-table'`,
	 * in source-preference order. */
	confirmedBy: { outbound: string; inbound: string };
	/** True when confirming this candidate's `C -> destination` leg spent a request
	 * against a metered `FlightProvider`. Always false when a free source (or the bundled
	 * table) already covered it, which is the common case. */
	meteredRequestSpent: boolean;
}

/**
 * The subset of `SearchQuery` this module reads. Kept as a `Pick` rather than a bespoke
 * type so the field names, defaults and semantics stay defined in exactly one place
 * (domain/search-query.ts) — this file adds no meaning of its own to any of them.
 * `soonestDeparture` is read only to build the minimal probe query `isFreeProvider` uses to
 * classify a `FlightProvider`, never to actually search anything.
 */
export type ConnectionQuery = Pick<
	SearchQuery,
	| 'originAirport'
	| 'destinationAirport'
	| 'forbiddenConnectionCountries'
	| 'forbiddenConnectionAirports'
	| 'allowedConnectionAirports'
	| 'soonestDeparture'
>;

export interface ConnectionWeights {
	sizeClass: number;
	detour: number;
	balance: number;
}

export interface ConnectionGraphOptions {
	/** Real flight adapters (issue #2's `FlightProvider`) to source route-graph edges
	 * from — a Ryanair adapter once one exists, and eventually a metered aggregator's.
	 * Each is classified free-to-call or metered by probing `estimateSearchOffersCost`
	 * (see `isFreeProvider`); free ones are unioned with the bundled fallback table and
	 * always queried, metered ones are used only as a last resort. Omit entirely and this
	 * module still works from the bundled table alone. */
	flightProviders?: FlightProvider[];
	/** This call's own slice of provider keys, for building each provider's
	 * `ProviderContext` (registry.ts's `contextFor`). Omit when every provider in
	 * `flightProviders` is keyless. */
	providerKeys?: AvailableKeys;
	/** Hard ceiling on how many requests the metered providers in `flightProviders`
	 * (combined) may spend, across this one call. Default `0`: metered spending is
	 * opt-in, never a silent default, exactly like `ProviderContext.maxRequests`
	 * elsewhere in this codebase exists to prevent a "convenient" method from quietly
	 * burning a monthly quota. */
	meteredRequestBudget?: number;
	/** Geography override for ranking and the forbidden-country filter, consulted before
	 * the real airport dataset (`../data/airports`) and the bundled fallback table, in
	 * that order. Mainly useful for tests; a normal caller can omit this entirely and get
	 * real-world geography for free. */
	airportLookup?: AirportLookup;
	/**
	 * Issue #130: called once per `listDirectDestinations` this module makes, with the exact
	 * `ProviderResult` the adapter returned, before this file collapses it into a route list.
	 * That collapse (`sourceFromProvider`, "a `{ ok: false }` result becomes an empty
	 * destination list") is deliberate for the algorithm and was silently fatal for the UI:
	 * candidate discovery is often every provider call a search makes — a route no free
	 * source connects never reaches the fare-fetching stage that reports its own calls — so
	 * with nothing reported here the results page showed "Nothing has answered yet" after
	 * Ryanair had answered twice.
	 *
	 * Reporting only. This module's own behaviour does not depend on it, and it never sees a
	 * key or anything derived from one, so a caller can leave it out entirely (tests do).
	 */
	onProviderResult?: (
		provider: Pick<FlightProvider, 'id' | 'kind' | 'label'>,
		result: ProviderResult<IataAirportCode[]>
	) => void;
	/** How many ranked candidates to return. Default `DEFAULT_MAX_CANDIDATES`. */
	maxCandidates?: number;
	/**
	 * Issue #350: called once, with the candidates this call confirmed on both legs and then
	 * dropped because `maxCandidates` was already full. Never called when nothing was
	 * dropped, which is most searches.
	 *
	 * Reporting only, exactly like `onProviderResult` above: this module's behaviour does not
	 * depend on it and a caller can leave it out. The cap itself is not the problem — each
	 * candidate kept costs two metered fare searches downstream, and issue #255 is this
	 * repo's own record of what bounding the wrong thing does. What was wrong is that the
	 * results page could say "six stopovers" when the search had confirmed nine, and nothing
	 * on screen distinguished the three it dropped from three that do not exist.
	 *
	 * These carry a full `ConnectionCandidate` rather than a bare code so a caller can rank
	 * or describe them; `SearchSnapshot` keeps only the codes, for the reason on that field.
	 */
	onCandidatesBeyondCap?: (beyondCap: readonly ConnectionCandidate[]) => void;
	/** How many ranked positions this call may spend a request on. Default
	 * `maxCandidates * ROUTE_PROBES_PER_KEPT_CANDIDATE`. See that constant for why the
	 * ceiling belongs here rather than inside each adapter, and for what a position can
	 * cost. Candidates past it are still asked about, but only of the sources that ship
	 * with the app and answer for free — see the probe loop in
	 * `findConnectionCandidates`. */
	maxRouteProbes?: number;
	/** Candidates whose detour ratio — `(dist(A,C) + dist(C,B)) / dist(A,B)` — exceeds
	 * this are dropped outright rather than merely scored low. Default
	 * `DEFAULT_MAX_DETOUR_RATIO`. Only applies when geography for A, B and the candidate
	 * is all known; see `scoreCandidate`. */
	maxDetourRatio?: number;
	/** Relative weight of each score component before they're summed. Renormalised when
	 * `detour` can't be computed for a candidate (its weight is redistributed across the
	 * other two) so an unknown airport is never penalised twice, once for having no
	 * detour score and again for that missing weight going nowhere. Default
	 * `DEFAULT_WEIGHTS`. */
	weights?: ConnectionWeights;
	signal?: AbortSignal;
}

/**
 * Default cap on ranked candidates. Each survivor costs two metered fare searches
 * downstream (build.ts / score.ts, not this file). At 6 candidates that's 12 of
 * Skyscanner's 20-requests-a-month free-tier budget (docs/PROVIDERS.md), leaving room
 * for the pipeline's own airport-resolution calls and, just as importantly, leaving this
 * from being the only search a user gets to run that month. A caller on a paid tier, or
 * one that has already decided to spend its whole budget on one search, can raise this.
 */
export const DEFAULT_MAX_CANDIDATES = 6;

/**
 * How many ranked positions this module may spend a request on, per candidate it intends
 * to keep. Issue #187.
 *
 * It bounds POSITIONS, not requests. This sentence used to say the opposite — "it bounds
 * requests, not candidates" — which is issue #378, and the difference is worth stating
 * because it cuts the other way from how it reads. A candidate the bundled sources confirm
 * for free still uses up a position without spending anything, so a search can stop asking
 * with budget left over. Measured on `pnpm qa`'s own scenario: twelve candidates ranked,
 * four confirmed for free, eight questions asked, out of eighteen positions.
 *
 * One position costs at most one route question per source, because the loop has exactly one
 * question to ask: does this candidate fly on to the destination. Every candidate is already
 * an airport a source says the origin flies to, and it carries that source's id with it, so
 * there is no second `A -> C` check to pay for. That is what makes the ceiling in
 * `route-graph-fanout.qa.ts` arithmetic rather than an observation, and connections.test.ts
 * holds it directly ("asks only the onward question, once per candidate").
 *
 * Issue #378 read a two-request position out of the older shape, where issue #349's
 * metro-sibling rule could propose an airport with no outbound edge. Issue #395 answered
 * that the two checks could not both fire; issue #380 removed the rule that made a second
 * check reachable at all.
 *
 * Swapping the index for a spend counter is not the fix, and was measured during #361's
 * design work: a bare counter walks until the budget is gone rather than stopping after
 * eighteen candidates, and saturates on every route tried. It needs a stopping rule beside
 * it, and the one sketched — stop once `maxCandidates` confirmed candidates all beat what
 * the next unwalked candidate could score at best — is an exact upper bound and so cannot
 * drop a candidate that would have been kept. Nobody has built it.
 *
 * This loop used to ask every airport the origin flies to for its route graph and then
 * keep six. For a hub that is hundreds of requests for six answers: BCN unions 79
 * resolvable outbound airports across Ryanair's bundled snapshot, the build-time
 * cheap-routes dataset and the fallback table, and STN unions 179. Every keyless
 * route-graph provider paid that, and each grew a private ceiling of its own to survive
 * it — `kiwi-public.ts`'s `MAX_ROUTE_LOOKUPS_PER_SESSION` being the blunt one, which
 * stops answering partway through a search.
 *
 * A ceiling inside an adapter can only say "I will stop after N". It cannot say which N,
 * because the adapter cannot see which candidates the search is going to keep. This one
 * can: every input to `scoreGeography` is bundled data, so the candidates get ranked
 * before any request is spent, and the requests go to the top of that ranking.
 *
 * Three per kept candidate, so a default search spends 18. It is a guess at a hit rate —
 * most candidates the origin flies to do not fly on to the destination, so the list has
 * to be walked some way past six to find six — and it stays a guess, because nothing
 * offline can tell you which airports a network route graph will confirm.
 *
 * What makes a guess tolerable here is that it no longer decides which cities the search
 * can find, only which ones cost a request to find. Before issue #255 it decided both,
 * and it decided wrong: geography ranks Birmingham 20th and Manchester 21st of BVC to
 * PFO's 21 candidates, both of them cut at 18, both of them in Ryanair's bundled snapshot
 * as flying to Pafos all along.
 *
 * The sentence this replaces read: "18 is also above the 19 route lookups issue #187
 * measured for the whole BVC to PFO search ... it never had more candidates than this."
 * 18 is not above 19, that search ranks 21 candidates rather than 18, and the conclusion
 * was the opposite of the truth.
 */
export const ROUTE_PROBES_PER_KEPT_CANDIDATE = 3;

/**
 * Above this detour ratio a "connection" is really just a wrong answer — the failure mode
 * the issue calls out by name: "a candidate that is technically reachable but two thousand
 * kilometres backwards is not a good stopover." 2.5 means the total A-C-B path may be up
 * to two and a half times the direct A-B great-circle distance; a candidate exactly on the
 * line scores a ratio of 1.0, so this still allows a generous amount of real-world
 * zig-zagging before excluding anything.
 */
export const DEFAULT_MAX_DETOUR_RATIO = 2.5;

/**
 * Detour weighted highest: geographic sanity is the one failure mode the issue names
 * explicitly. `sizeClass` gets the smallest share on purpose — see the honest disclaimer
 * on `SIZE_CLASS_SCORES` below for why it isn't trusted with more than that.
 *
 * These are ratios, not shares, and `combineScore` renormalises them, so they do not have
 * to sum to anything. They summed to 1 while a fourth component, `connectivity`, held 0.4.
 * It was removed by issue #381 and the other three were left at the numbers they had, so
 * that removing a term could not double as retuning the ones that stayed. Their order and
 * their ratios to each other are untouched.
 *
 * Connectivity scored `min(1, onwardDestinationsKnown / 20)` and carried the largest
 * weight in this table, and it separated nothing. Measured over the real bundled datasets
 * on twelve routes: 1.000 for every candidate on nine of them, including every candidate
 * on BVC to PFO and BCN to SOF, and on the other three only a handful of airports past
 * position fifty scored below it. Never a candidate the search kept. The same probe run
 * against the commit before the vendored route graph landed gives 1.000 for all thirteen
 * BCN to SOF candidates, so the graph made an old problem visible rather than causing it.
 *
 * Widening the saturation point was the obvious repair and is the wrong one. It would
 * turn the component into "prefer the biggest hub", which is the claim `SIZE_CLASS_SCORES`
 * below already makes with better data, and which the disclaimer there explains is not the
 * same as "worth a stopover". The measure was also unfair in the way issue #349 named:
 * out-degree is how much our snapshot happens to know about an airport, so Aarhus scoring
 * 0.850 and Vaxjo 0.450 was Wikipedia article length, not a dead end. And by the time a
 * candidate is scored, a source has already confirmed it flies from the origin and on to
 * the destination, so "does this airport have onward routes at all" is answered yes by the
 * candidate existing.
 *
 * What should carry that weight instead is an open question with no honest answer in this
 * repo today. Nothing here knows whether a city is worth a night, and inventing a signal
 * that says so is the same trap the size disclaimer refuses.
 */
export const DEFAULT_WEIGHTS: ConnectionWeights = {
	sizeClass: 0.15,
	detour: 0.25,
	balance: 0.2
};

/**
 * Airport size does NOT proxy "somewhere a person would want to spend a few days" — a
 * large airport means well-connected, not interesting. Vienna and Frankfurt are both
 * `large`; only one of them is a city worth lingering in, and this module has no way to
 * tell them apart on size alone. An "is this a national capital" stand-in was considered
 * and rejected for the same reason: Barcelona is one of Europe's best short-break cities
 * and is not Spain's capital, so that signal would just trade one wrong bias for another.
 * No tourism, population or points-of-interest data exists anywhere in this codebase
 * (the airport dataset, issue #11, carries none), and hand-picking a list of "nice
 * cities" would be a taste judgement dressed up as a data source, not a fix.
 *
 * So this component is scored honestly for what size class actually does tell us: a
 * bigger airport has more rebooking options if a flight is cancelled and is generally
 * simpler to get in and out of. That's real value, just a narrower and weaker claim than
 * "worth visiting" — which is why it carries the smallest weight in `DEFAULT_WEIGHTS`,
 * not the largest. A genuine stopover-appeal signal is a data problem for a future issue,
 * not something to fake here.
 */
const SIZE_CLASS_SCORES: Record<AirportSizeClass, number> = {
	large: 1,
	medium: 0.6,
	small: 0.3
};

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
	return (degrees * Math.PI) / 180;
}

/** Great-circle distance in km. Used for the detour check, never for anything requiring
 * real flight-path or driving distance. */
function haversineDistanceKm(a: Coordinates, b: Coordinates): number {
	const dLat = toRadians(b.latitude - a.latitude);
	const dLon = toRadians(b.longitude - a.longitude);
	const lat1 = toRadians(a.latitude);
	const lat2 = toRadians(b.latitude);
	const h =
		Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Wraps `FALLBACK_ROUTES` as a `DirectDestinationSource` so the main algorithm below
 * never has to know the fallback table's own shape — it just looks like the least
 * preferred source in the list. */
function fallbackRouteSource(): DirectDestinationSource {
	return {
		id: 'fallback-table',
		getDirectDestinations(iataCode) {
			return Promise.resolve([...(FALLBACK_ROUTES.get(iataCode) ?? [])]);
		}
	};
}

/**
 * Adapts a free (cost-0) `FlightProvider` into this module's own `DirectDestinationSource`
 * shape, so it can be unioned alongside the bundled fallback table through the exact same
 * code path (`unionDirectDestinations`). A `{ ok: false }` result becomes an empty
 * destination list rather than a thrown error, so a failing provider falls through to
 * whatever source runs next — ultimately the bundled table — the same as if it had simply
 * never heard of the airport. Never a search failure.
 */
function sourceFromProvider(
	provider: FlightProvider,
	providerKeys: AvailableKeys,
	signal: AbortSignal,
	onProviderResult?: ConnectionGraphOptions['onProviderResult']
): DirectDestinationSource {
	return {
		id: provider.id,
		async getDirectDestinations(iataCode) {
			const ctx = contextFor(provider.id, providerKeys, signal);
			const result = await provider.listDirectDestinations(iataCode, ctx);
			// Reported before the collapse below, so the caller sees "answered with an empty
			// list" as its own fact rather than inferring it from a shorter route graph.
			onProviderResult?.(provider, result);
			return result.ok ? result.data : [];
		},
		confirmsRoute: provider.hasDirectRoute
			? async (origin, destination) => {
					const ctx = contextFor(provider.id, providerKeys, signal);
					const result = await provider.hasDirectRoute!(origin, destination, ctx);
					// Reported as a destination list of one so the status panel counts this
					// call the same way it counts every other route lookup: it is one request
					// to the same provider asking the same kind of question, and leaving it
					// out would make a search look cheaper than it is (issue #130).
					onProviderResult?.(
						provider,
						result.ok
							? { ...result, data: result.data ? [destination] : [] }
							: result
					);
					return result.ok && result.data;
				}
			: undefined
	};
}

/**
 * `FlightProvider` has no cost estimator for `listDirectDestinations` specifically — only
 * `estimateSearchOffersCost`, for `searchOffers`. Every adapter that has a native one-shot
 * route-graph endpoint (a keyless provider like Ryanair) also has a native date-range
 * `searchOffers` endpoint and reports 0 for both; every adapter that has to fan out into
 * individually metered requests reports non-zero for both. So probing
 * `estimateSearchOffersCost` with a minimal single-day query is a real, already-available
 * signal for "is this adapter free to call as much as this module needs" — no separate
 * cost method needed just for this file, and no out-of-band "trust me, this one's
 * metered" flag for a caller to get wrong. `estimateSearchOffersCost` is synchronous and
 * makes no network call, so this classification costs nothing.
 */
function isFreeProvider(provider: FlightProvider, query: ConnectionQuery): boolean {
	const probe: FlightSearchQuery = {
		origin: query.originAirport,
		destination: query.destinationAirport,
		// A single day is enough to tell "0" from "not 0" — the only thing this probe
		// needs to establish. The real search dates (build.ts / score.ts) are never
		// influenced by this call.
		earliestDeparture: query.soonestDeparture,
		latestDeparture: query.soonestDeparture
	};
	return provider.estimateSearchOffersCost(probe) === 0;
}

async function resolveAirportInfo(
	iataCode: IataAirportCode,
	customLookup?: AirportLookup
): Promise<ConnectionAirportInfo | undefined> {
	if (customLookup) {
		const result = await customLookup(iataCode);
		if (result) return result;
	}
	// The real dataset (issue #11) is a bundled, lazily-loaded JSON import, not a network
	// call — consulting it here keeps this module offline-safe while giving real-world
	// geography for any airport, not just the ~18 in the bundled fallback below.
	const fromDataset = await getAirport(iataCode);
	if (fromDataset) {
		return {
			coordinates: fromDataset.coordinates,
			sizeClass: fromDataset.sizeClass,
			countryCode: fromDataset.country.isoCode
		};
	}
	return FALLBACK_AIRPORTS.get(iataCode);
}

/**
 * Queries every source for `iataCode`'s direct destinations and unions the results,
 * keeping the id of whichever source (in `sources` order, i.e. cheapest/most-preferred
 * first) reported each destination first. Union rather than "first source that answers
 * wins" on purpose: these are all free-to-query sources at this point in the algorithm
 * (metered providers are never passed in here — see the two call sites below), so more
 * recall never costs anything, and Ryanair being one airline (docs/prompts/004: "a
 * source that queries one carrier is not acceptable as the primary engine") means it
 * alone would under-count real candidates.
 */
async function unionDirectDestinations(
	sources: DirectDestinationSource[],
	iataCode: IataAirportCode
): Promise<Map<IataAirportCode, string>> {
	const byCode = new Map<IataAirportCode, string>();
	for (const source of sources) {
		const destinations = await source.getDirectDestinations(iataCode);
		for (const code of destinations) {
			if (!byCode.has(code)) byCode.set(code, source.id);
		}
	}
	return byCode;
}

/**
 * Issue #340: asks each source, in preference order, whether it has this exact pair, and
 * stops at the first that says yes.
 *
 * This replaces "fetch everywhere `origin` flies, then check whether `destination` is in
 * it" for every source that can tell the two apart. They are not the same question.
 * `kiwi-public`'s list comes from a price-sorted "fly me anywhere" fare search returning one
 * row per destination *city*, so Milan appears once — as Malpensa — and Bergamo is missing
 * from it while Kiwi will happily sell you Boa Vista to Bergamo. The same list drops a hub's
 * thinner routes: Paphos is in none of Munich's, Orly's, Amsterdam's, Brussels' or
 * Fiumicino's, and Kiwi sells all five.
 *
 * Each source answers the best way it can, decided per source rather than for the group. One
 * source growing an exact check must never silence another that only has a list, or adding
 * the capability to a single adapter would delete every candidate the others vouched for.
 *
 * Returns the id of the source that confirmed the pair, or `undefined` if none did. It used
 * to also report the longest destination list it happened to see on the way, which fed the
 * connectivity score. Issue #381 removed that component, and with it the only reason a route
 * check ever counted anything.
 */
async function confirmDirectRoute(
	sources: DirectDestinationSource[],
	origin: IataAirportCode,
	destination: IataAirportCode
): Promise<string | undefined> {
	for (const source of sources) {
		if (source.confirmsRoute) {
			if (await source.confirmsRoute(origin, destination)) return source.id;
			continue;
		}
		const destinations = await source.getDirectDestinations(origin);
		if (destinations.includes(destination)) return source.id;
	}
	return undefined;
}

/** What one attempt at the metered, last-resort path produced. `sourceId` is `undefined`
 * when every provider tried either failed (`{ ok: false }`) or ran out of budget before
 * confirming anything — never a thrown error. `spent` is always accurate (a rejected
 * request still cost quota — `ProviderResult.requestsUsed` says so per adapter), so the
 * caller's budget accounting is correct even on total failure. */
interface MeteredQueryResult {
	destinations: IataAirportCode[];
	sourceId: string | undefined;
	spent: number;
}

/**
 * Tries each metered provider in turn, stopping as soon as one confirms `iataCode`'s
 * direct destinations or `budget` runs out. A provider's `{ ok: false }` falls through to
 * the next metered provider exactly like a free source's empty answer falls through to
 * the next free source — never a search failure.
 */
async function queryMeteredProviders(
	providers: FlightProvider[],
	iataCode: IataAirportCode,
	providerKeys: AvailableKeys,
	signal: AbortSignal,
	budget: number,
	onProviderResult?: ConnectionGraphOptions['onProviderResult']
): Promise<MeteredQueryResult> {
	let spent = 0;
	for (const provider of providers) {
		if (spent >= budget) break;
		const ctx = contextFor(provider.id, providerKeys, signal);
		const result = await provider.listDirectDestinations(iataCode, ctx);
		onProviderResult?.(provider, result);
		spent += result.requestsUsed;
		if (result.ok) return { destinations: result.data, sourceId: provider.id, spent };
	}
	return { destinations: [], sourceId: undefined, spent };
}

interface ScoredCandidate {
	score: number;
	breakdown: ConnectionScoreBreakdown;
}

/** The two score components that need no provider: both come from the bundled airport
 * dataset and pure geometry, so every candidate can be given one before a single request
 * goes out. `detour` is `null` when geography for A, B or C is unknown. */
interface CandidateGeographyScore {
	sizeClass: number;
	detour: number | null;
	/**
	 * How evenly the candidate splits the journey: 1 for a stopover halfway, falling to 0 at
	 * either end. `null` exactly when `detour` is, since both need all three positions.
	 *
	 * Issue #340, and it exists because `detour` has a degenerate maximum. An airport forty
	 * minutes from the origin adds nothing to the total distance, so it scores a perfect
	 * ratio of about 1.0 — not because it is a good stopover but because it is barely a
	 * journey. Ranking on detour alone therefore fills its own top with airports that have
	 * not gone anywhere, and leaves the whole trip to a second leg nothing there flies.
	 *
	 * Measured on BCN to BVC, the owner's own search. The eighteen best-ranked candidates
	 * were Rabat, Málaga, Tangier, Fuerteventura, Lanzarote, Marrakesh, Alicante, Las
	 * Palmas, Fez, Seville, Nador, Ouarzazate, Tenerife North, Faro, Ibiza, Oujda, Madrid
	 * and Palma. Every one of them is close to the line to Cape Verde and not one of them
	 * flies there. Lisbon, which does, ranked **nineteenth** — one place past the probe
	 * ceiling — and Porto, Milan, Rome, Bergamo and Birmingham sat behind it.
	 *
	 * A connection is a journey cut in two. This says so, and it costs nothing to know.
	 */
	balance: number | null;
}

/**
 * Scores the half of a candidate that geography alone decides. Returns `null` when the
 * candidate should be excluded outright — currently only the detour-too-large case, and
 * only when geography for A, B and the candidate are all known; an unknown candidate is
 * scored without that component rather than assumed to be a bad detour, since "we don't
 * know" and "we know it's bad" are different things and only the second should disqualify
 * anything (AGENTS.md: "say what you do not know rather than guessing").
 */
function scoreGeography({
	candidateGeo,
	originGeo,
	destinationGeo,
	maxDetourRatio
}: {
	candidateGeo: ConnectionAirportInfo | undefined;
	originGeo: ConnectionAirportInfo | undefined;
	destinationGeo: ConnectionAirportInfo | undefined;
	maxDetourRatio: number;
}): CandidateGeographyScore | null {
	const sizeClass = candidateGeo ? SIZE_CLASS_SCORES[candidateGeo.sizeClass] : 0.5;

	if (!candidateGeo || !originGeo || !destinationGeo) {
		return { sizeClass, detour: null, balance: null };
	}

	const direct = haversineDistanceKm(originGeo.coordinates, destinationGeo.coordinates);
	if (direct <= 0) return { sizeClass, detour: null, balance: null };

	const outboundLeg = haversineDistanceKm(originGeo.coordinates, candidateGeo.coordinates);
	const onwardLeg = haversineDistanceKm(candidateGeo.coordinates, destinationGeo.coordinates);
	const viaCandidate = outboundLeg + onwardLeg;
	const ratio = viaCandidate / direct;
	if (ratio > maxDetourRatio) return null;

	// 1 when the two legs are equal, 0 when the candidate sits on top of the origin or the
	// destination. See `CandidateGeographyScore.balance` for the eighteen dead ends this
	// exists to rank below Lisbon.
	const outboundShare = viaCandidate > 0 ? outboundLeg / viaCandidate : 0;
	return {
		sizeClass,
		detour: Math.max(0, 1 - (ratio - 1) / (maxDetourRatio - 1)),
		balance: 1 - Math.abs(2 * outboundShare - 1)
	};
}

/**
 * Ryanair's bundled network snapshot as a `DirectDestinationSource`, the same shape the
 * fallback table wears above. Issue #255.
 *
 * The whole route graph ships with the app (issue #121), so this answers "which airports
 * does C fly to" out of memory: no request, no key, no waiting on a provider, and the
 * same answer on every load. That is what lets the probe loop below ask about candidates
 * it has no request budget left for.
 *
 * It overlaps the real Ryanair adapter, which reads the same snapshot, and that is fine:
 * `unionDirectDestinations` unions, and the adapter is preferred when both are present
 * because it can refresh the snapshot while this one cannot.
 */
function bundledRyanairSource(): DirectDestinationSource {
	return {
		id: 'bundled-ryanair-network',
		async getDirectDestinations(iataCode) {
			const snapshot = await loadBundledRyanairNetwork();
			return [...(snapshot.destinationsByOrigin[iataCode] ?? [])];
		}
	};
}

/**
 * The vendored all-carrier route graph as a `DirectDestinationSource`. Issue #361.
 *
 * This is the source that proposes a candidate no provider's list names. Boa Vista's own
 * sampled list has 20 rows and East Midlands is in none of them; this graph gives Boa Vista
 * 27 neighbours and East Midlands is one, so `EMA` arrives in `outboundEdges` like any other
 * candidate and the search can finally think of the route it was already able to confirm.
 *
 * It answers both questions out of memory, so it costs no request either way, which is why
 * it goes first in `bundledSources` and why answering here removes a request `kiwi-public`
 * would otherwise spend.
 *
 * `confirmsRoute` returning `false` means "this table does not say so", never "no such
 * route", and `confirmDirectRoute` falls through to the next source on a `false` for exactly
 * that reason. The graph is hand-edited encyclopedia text: it names 98.6% of the edges in
 * Ryanair's own bundled snapshot rather than all of them, so it is a floor and never a
 * ceiling, and it must never silence a source that knows better.
 *
 * Deliberately absent from `hasKnownDirectRoute` below. That function answers "is there a
 * direct flight" to a traveller, and an encyclopedia asserting one there would be the
 * invention AGENTS.md forbids. This graph proposes; it does not announce.
 */
function bundledDirectRoutesSource(): DirectDestinationSource {
	return {
		id: 'bundled-direct-routes',
		async getDirectDestinations(iataCode) {
			return neighboursOf(await loadBundledDirectRoutes(), iataCode);
		},
		async confirmsRoute(origin, destination) {
			return hasDirectRoute(await loadBundledDirectRoutes(), origin, destination);
		}
	};
}

/**
 * Weights the geography components into the final number.
 *
 * Every input is bundled data, so this costs nothing and gives the same answer before and
 * after a request. Until issue #381 it took a fourth argument, the candidate's out-degree,
 * and had to be called twice per candidate for that reason — once to rank, once to rescore
 * whatever the probe learned. Now it is called once.
 */
function combineScore(
	geography: CandidateGeographyScore,
	weights: ConnectionWeights
): ScoredCandidate {
	const { sizeClass, detour, balance } = geography;

	// Redistribute the geography weights across the remaining components when they're
	// unavailable, so a candidate with no known geography isn't penalised twice over
	// (once for scoring 0 on them, again for that weight being spent on nothing).
	const usableWeight =
		weights.sizeClass +
		(detour === null ? 0 : weights.detour) +
		(balance === null ? 0 : weights.balance);
	const w = {
		sizeClass: weights.sizeClass / usableWeight,
		detour: detour === null ? 0 : weights.detour / usableWeight,
		balance: balance === null ? 0 : weights.balance / usableWeight
	};

	const score = sizeClass * w.sizeClass + (detour ?? 0) * w.detour + (balance ?? 0) * w.balance;
	return { score, breakdown: { sizeClass, detour, balance } };
}

/**
 * Finds and ranks candidate stopover airports for `query.originAirport ->
 * query.destinationAirport`, respecting the brief's forbidden-country/airport list and
 * optional allow-list, capped at `options.maxCandidates`. See the module doc comment for
 * the source order and the request-budget reasoning.
 *
 * Returns `[]`, doing no work at all, when origin and destination are the same airport —
 * "connecting through yourself" isn't a stopover.
 */
export async function findConnectionCandidates(
	query: ConnectionQuery,
	options: ConnectionGraphOptions = {}
): Promise<ConnectionCandidate[]> {
	const { originAirport: origin, destinationAirport: destination } = query;
	if (origin === destination) return [];

	const {
		flightProviders = [],
		providerKeys = {},
		meteredRequestBudget = 0,
		airportLookup,
		onProviderResult,
		maxCandidates = DEFAULT_MAX_CANDIDATES,
		onCandidatesBeyondCap,
		maxRouteProbes = maxCandidates * ROUTE_PROBES_PER_KEPT_CANDIDATE,
		maxDetourRatio = DEFAULT_MAX_DETOUR_RATIO,
		weights = DEFAULT_WEIGHTS,
		signal
	} = options;

	const effectiveSignal = signal ?? new AbortController().signal;

	// Classified once per provider, not once per candidate: estimateSearchOffersCost is
	// pure and depends only on the provider and this one probe query.
	const freeProviders: FlightProvider[] = [];
	const meteredProviders: FlightProvider[] = [];
	for (const provider of flightProviders) {
		(isFreeProvider(provider, query) ? freeProviders : meteredProviders).push(provider);
	}

	// The fallback table is always unioned in last so it never shadows a better source's
	// answer, but it always contributes something — this is what "first paint and
	// offline both work" (issue #12) actually means in code.
	// The vendored route graph sits after the live providers and before the hand table. A
	// live provider still wins attribution in `unionDirectDestinations`, which keeps the
	// first source to report each destination, and the hand table stays last as it always
	// has: it never shadows a better answer and it always contributes something.
	const freeSources: DirectDestinationSource[] = [
		...freeProviders.map((p) => sourceFromProvider(p, providerKeys, effectiveSignal, onProviderResult)),
		bundledDirectRoutesSource(),
		fallbackRouteSource()
	];
	// The subset of the above that answers out of data shipped with the app. Asking these
	// costs no request, so the probe loop can ask them about candidates the ceiling has
	// already spent its request budget on. Issue #255. The route graph goes first because it
	// is the broadest of the three, so a hit there is a request nothing else has to spend.
	const bundledSources: DirectDestinationSource[] = [
		bundledDirectRoutesSource(),
		bundledRyanairSource(),
		fallbackRouteSource()
	];

	const forbiddenAirports = new Set(query.forbiddenConnectionAirports ?? []);
	const forbiddenCountries = new Set(query.forbiddenConnectionCountries ?? []);
	const allowList = query.allowedConnectionAirports
		? new Set(query.allowedConnectionAirports)
		: undefined;

	let remainingMeteredBudget = Math.max(0, meteredRequestBudget);

	const [originGeo, destinationGeo] = await Promise.all([
		resolveAirportInfo(origin, airportLookup),
		resolveAirportInfo(destination, airportLookup)
	]);

	// Step 1: which airports does the origin fly to directly, from free sources only.
	const outboundEdges = await unionDirectDestinations(freeSources, origin);

	if (outboundEdges.size === 0 && meteredProviders.length > 0 && remainingMeteredBudget > 0) {
		if (effectiveSignal.aborted) throw new DOMException('Aborted', 'AbortError');
		// SPENDS A METERED REQUEST: free sources have nothing at all for the origin
		// airport (not even the bundled fallback covers it), so candidate discovery has
		// no other way to start. This runs at most once per call, never once per
		// candidate.
		const result = await queryMeteredProviders(
			meteredProviders,
			origin,
			providerKeys,
			effectiveSignal,
			remainingMeteredBudget,
			onProviderResult
		);
		remainingMeteredBudget -= result.spent;
		if (result.sourceId) {
			for (const code of result.destinations) outboundEdges.set(code, result.sourceId);
		}
	}

	// A candidate is an airport a source says the origin flies to, carrying the id of that
	// source. Paired rather than looked up again later, so a candidate whose outbound leg
	// nothing vouches for cannot be built at all — see the probe loop, which now has one
	// question to ask rather than two.
	let proposed: [IataAirportCode, string][] = [...outboundEdges].filter(
		([code]) => code !== origin && code !== destination
	);
	if (allowList) {
		// An explicit allow-list narrows the universe rather than replacing it: an
		// allowed airport the origin has no known outbound edge to at all still isn't
		// addressable here without a metered call per allow-listed code just to test
		// reachability, which would defeat "last resort" for a list that could be long.
		// A caller who needs that supplies a provider with better outbound coverage.
		proposed = proposed.filter(([code]) => allowList.has(code));
	}

	// Step 2, and the whole of issue #187: rank every candidate on what costs nothing to
	// know, so the requests in step 3 are spent on the airports most likely to survive.
	// Geography comes from the bundled dataset, so this pass touches no network at all.
	const ranked: {
		code: IataAirportCode;
		outboundSourceId: string;
		scored: ScoredCandidate;
	}[] = [];

	for (const [code, outboundSourceId] of proposed) {
		// Forbidden airports are filtered here, not downstream, so a forbidden candidate
		// never reaches a fare search that would spend a request on it (issue #12: "filtered
		// out here rather than later"). Checked before the allow-list interaction above
		// even matters: forbidden always wins, even over an explicit allow-list entry.
		if (forbiddenAirports.has(code)) continue;

		const candidateGeo = await resolveAirportInfo(code, airportLookup);

		// A code no geography tier resolves is not a single real airport at all — most
		// often an IATA *metropolitan* code (ROM, PAR, MIL, MOW, TCI, ...), which a
		// route-graph source can list as if it were a destination even though it covers
		// several airports at once (issue #89: the Travelpayouts cheap-routes dataset does
		// exactly this for Rome, Paris and Milan). Every airport-level provider this
		// module talks to rejects a code like that outright, so it's dropped here, before
		// any request is built for it, rather than surviving to be scored down or to burn
		// a real network call downstream (the 13 failing Ryanair requests issue #89
		// measured were each one of these being probed for its own onward routes). This
		// also covers a genuinely unknown/typo'd code, which fails the exact same way for
		// the exact same reason: neither is an airport this module can query.
		if (!candidateGeo) continue;

		// Fail closed: a candidate whose country can't be determined can't be cleared
		// against the forbidden list either, so it's dropped rather than risked. Only
		// applies when a forbidden list was actually given, so a candidate with no
		// geography isn't penalised for a filter that was never in effect. (candidateGeo
		// is always defined past the check above, but the list only matters when it's
		// non-empty, so that's still worth its own guard.)
		if (forbiddenCountries.size > 0 && forbiddenCountries.has(candidateGeo.countryCode)) continue;

		const geography = scoreGeography({
			candidateGeo,
			originGeo,
			destinationGeo,
			maxDetourRatio
		});
		if (!geography) continue; // Excluded: detour ratio beyond maxDetourRatio.

		// One score per candidate, and the one it keeps. Until issue #381 this was a floor
		// — the score if the candidate turned out to fly nowhere onward — and step 3
		// recomputed it once a probe had learned the real out-degree. With connectivity
		// gone there is nothing left a request can teach the scorer.
		ranked.push({ code, outboundSourceId, scored: combineScore(geography, weights) });
	}

	ranked.sort((a, b) => b.scored.score - a.scored.score || a.code.localeCompare(b.code));

	const candidates: ConnectionCandidate[] = [];

	// Step 3: the only pass that can cost a request. The spending is bounded, and it goes
	// out in an order fixed by bundled data alone, which is what makes a reload cheap
	// (issue #194): the first load caches exactly the set the second load asks for, so the
	// second asks for nothing.
	for (const [index, { code, outboundSourceId, scored }] of ranked.entries()) {
		// `maxRouteProbes` bounds RANKED POSITIONS, which is what `index` is, and not
		// requests — issue #378, where the constant's own doc comment said requests for a
		// long time. Past it every source that would cost something is dropped and the
		// candidate is still asked of the ones that ship with the app, which answer out of
		// memory. A candidate those confirm for free therefore uses up a position without
		// spending anything.
		//
		// That distinction is issue #255. Geography decided which candidates were ever
		// asked, and a city can rank mediocre on geography while being the one that
		// actually flies on — the exact question the probe exists to answer, so settling
		// it by ranking beforehand is circular. Where the bundled graph has already
		// answered it, the circle costs nothing to cut. Measured on BVC to PFO, the route
		// docs/ACCEPTANCE.md is about: 21 candidates ranked, Birmingham 20th and
		// Manchester 21st, and both of them in Ryanair's bundled snapshot as flying to
		// Pafos. They were the two the ceiling threw away.
		// Stopping here once `maxCandidates` have confirmed was tried and reverted, because
		// the loop walked in rank order while the survivors were chosen by score, so stopping
		// early kept the first six confirmed rather than the best six. Issue #381 removed the
		// one component that made those two orders differ, so they now coincide and the
		// objection no longer applies. Not taken here, because it changes what a search
		// requests and therefore what the first load caches, which is issue #194's whole
		// subject and needs its own measurements. What it would save, on `pnpm qa`'s own
		// scenario: four of its eight route questions come after the sixth confirmation.
		const withinRequestBudget = index < Math.max(0, maxRouteProbes);

		// Bundled first, always, because it costs nothing and it is complete for what it
		// covers: Ryanair's snapshot is Ryanair's whole network, so a hit here is a real
		// confirmation and not a sample. Issue #340 — the seven of BVC to PFO's candidates
		// that Ryanair already reaches Pafos from now settle for zero requests, which is
		// what pays for the wider candidate set this change produces.
		const bundledEdges = await unionDirectDestinations(bundledSources, code);
		let inboundSourceId = bundledEdges.get(destination);
		let meteredRequestSpent = false;

		if (!inboundSourceId && withinRequestBudget) {
			// Issue #340: ask the pair question rather than fetching everywhere `code` flies
			// and checking membership. Same one request, and an answer that is about this
			// route instead of about what happened to be cheap out of `code` this week.
			inboundSourceId = await confirmDirectRoute(freeSources, code, destination);
		}

		if (
			!inboundSourceId &&
			withinRequestBudget &&
			meteredProviders.length > 0 &&
			remainingMeteredBudget > 0 &&
			allowList?.has(code)
		) {
			if (effectiveSignal.aborted) throw new DOMException('Aborted', 'AbortError');
			// SPENDS A METERED REQUEST: only reached for a candidate the caller explicitly
			// allow-listed (so it's known to matter to this search) and only when every
			// free source came back without a C -> destination edge. Never reached during
			// broad, un-allow-listed discovery, where the candidate count could be large
			// enough to burn the whole monthly quota checking reachability alone.
			const result = await queryMeteredProviders(
				meteredProviders,
				code,
				providerKeys,
				effectiveSignal,
				remainingMeteredBudget,
				onProviderResult
			);
			remainingMeteredBudget -= result.spent;
			meteredRequestSpent = result.spent > 0;
			if (result.sourceId) {
				inboundSourceId = result.destinations.includes(destination) ? result.sourceId : undefined;
			}
		}

		if (!inboundSourceId) continue; // No source, free or metered, confirms C -> destination.

		candidates.push({
			airportCode: code,
			score: scored.score,
			breakdown: scored.breakdown,
			confirmedBy: { outbound: outboundSourceId, inbound: inboundSourceId },
			meteredRequestSpent
		});
	}

	candidates.sort((a, b) => b.score - a.score || a.airportCode.localeCompare(b.airportCode));
	const cap = Math.max(0, maxCandidates);
	// Issue #350: reported before the slice throws them away, and only when there is
	// something to report. Every one of these passed the same two confirmations the kept
	// candidates passed — a source says the origin flies here, and a source says something
	// flies onward — so "we found it and are not pricing it" is a fact, not a guess.
	if (candidates.length > cap) onCandidatesBeyondCap?.(candidates.slice(cap));
	return candidates.slice(0, cap);
}

/**
 * Issue #107: a cheap, keyless answer to "does a direct A -> B flight exist at all".
 * Meant to be asked only once `findConnectionCandidates` has already come back with
 * nothing worth a stopover for the same origin and destination, which is the moment
 * the empty-results UI needs to say which of two different things happened: no
 * stopover beats a direct flight (often because the route is well served direct), or
 * the search genuinely found nothing. Reuses exactly the free sources this module
 * already queries for its own outbound-edge lookup (a keyless `FlightProvider` such
 * as Ryanair's route graph or the Travelpayouts cheap-routes dataset, plus the
 * bundled fallback table). Never a new source, and never a metered one, matching
 * this module's own "spends nothing metered unless the caller explicitly opts in"
 * rule for candidate discovery.
 *
 * A `false` covers two different real situations this can't tell apart: "no free
 * source lists a direct route" and "one exists but none of these sources happens to
 * know about it." That is the same honesty limit the rest of this module already
 * lives with for stopover candidates, so `false` here means "not confirmed," never
 * "confirmed absent" (AGENTS.md: "say what you do not know rather than guessing").
 * A caller must word its copy that way rather than asserting no flights exist.
 */
/**
 * IATA *city* codes that cover more than one airport, mapped to their member airports.
 * `hasKnownDirectRoute` needs this because a free source can name a destination by its
 * city rather than a specific airport: the Travelpayouts cheap-routes dataset reports a
 * Paris fare as "PAR", never which of CDG/ORY/BVA it actually flew into (the same
 * aliasing `findConnectionCandidates` already has to filter out for a stopover
 * candidate, this file's own comment above on "an IATA *metropolitan* code"). Without
 * this table, checking BCN -> CDG specifically would miss a real cached direct fare
 * that exists under the alias "BCN -> PAR" and wrongly report "not confirmed" for
 * issue #107's own named example.
 *
 * Deliberately small and hand-curated, the same trade-off `connections-fallback-data.ts`
 * makes for its bundled route table: this app carries no general IATA city-code
 * dataset, so it covers only the handful of cities common enough for this check to
 * plausibly matter, not every multi-airport city on earth. A city missing from this
 * table degrades to the same "not confirmed" answer as any other unlisted route,
 * never a wrong one.
 *
 * One caller, and only that one. Issue #349 also read this table the other way round, to
 * propose an airport a source's one-row-per-city answer had hidden behind its city's other
 * airport, and issue #380 deleted that: the vendored route graph names LIN, MXP and BGY
 * separately, so it recovers those airports without needing to know they share a city.
 */
const METRO_CODE_MEMBERS: Readonly<Record<string, readonly IataAirportCode[]>> = {
	PAR: ['CDG', 'ORY', 'BVA'],
	LON: ['LHR', 'LGW', 'STN', 'LTN', 'LCY', 'SEN'],
	ROM: ['FCO', 'CIA'],
	MIL: ['MXP', 'LIN', 'BGY'],
	MOW: ['SVO', 'DME', 'VKO'],
	STO: ['ARN', 'BMA', 'NYO', 'VST'],
	NYC: ['JFK', 'LGA', 'EWR'],
	TYO: ['HND', 'NRT'],
	OSA: ['ITM', 'KIX'],
	CHI: ['ORD', 'MDW'],
	WAS: ['IAD', 'DCA', 'BWI']
};

export async function hasKnownDirectRoute(
	query: Pick<ConnectionQuery, 'originAirport' | 'destinationAirport' | 'soonestDeparture'>,
	options: Pick<ConnectionGraphOptions, 'flightProviders' | 'providerKeys' | 'signal' | 'onProviderResult'> = {}
): Promise<boolean> {
	const { originAirport: origin, destinationAirport: destination } = query;
	if (origin === destination) return false;

	const { flightProviders = [], providerKeys = {}, signal, onProviderResult } = options;
	const effectiveSignal = signal ?? new AbortController().signal;
	const freeSources: DirectDestinationSource[] = [
		...flightProviders
			.filter((provider) => isFreeProvider(provider, query))
			.map((provider) => sourceFromProvider(provider, providerKeys, effectiveSignal, onProviderResult)),
		fallbackRouteSource()
	];

	const outboundEdges = await unionDirectDestinations(freeSources, origin);
	if (outboundEdges.has(destination)) return true;

	// A free source may have reported the destination's city rather than the specific
	// airport the caller asked about (see METRO_CODE_MEMBERS above) — check every metro
	// code that counts `destination` as a member before giving up.
	for (const [metroCode, members] of Object.entries(METRO_CODE_MEMBERS)) {
		if (members.includes(destination) && outboundEdges.has(metroCode)) return true;
	}
	return false;
}

/*
 * Follow-up (out of this issue's scope, per AGENTS.md "work only on your issue"):
 *   - A real Ryanair `FlightProvider` now exists (issue #6, `../providers/flights/ryanair`
 *     — `createRyanairFlightProvider()`) and is proven to interoperate with this module in
 *     `connections.test.ts`. Actually passing it into `flightProviders` for a live search
 *     is the search pipeline's job (issue #22), not this file's — this module stays
 *     injectable rather than importing and instantiating a network-calling adapter itself,
 *     the same way build.ts and score.ts stay pure and take data in rather than fetching
 *     it.
 *   - Wire a metered aggregator's `FlightProvider` in as another `flightProviders` entry
 *     with a caller-chosen `meteredRequestBudget`, once such an adapter exists.
 */
