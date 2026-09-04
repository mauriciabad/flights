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
 */

import type {
	AirportSizeClass,
	Coordinates,
	IataAirportCode,
	IsoCountryCode,
	SearchQuery
} from '../domain';
import { getAirport } from '../data/airports';
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
	connectivity: number;
	sizeClass: number;
	detour: number | null;
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
	connectivity: number;
	sizeClass: number;
	detour: number;
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
 * explicitly. Connectivity gets most of the rest, because it measures something this
 * module can actually observe (does this airport have onward routes at all). `sizeClass`
 * gets a smaller share on purpose — see the honest disclaimer on `SIZE_CLASS_SCORES`
 * below for why it isn't trusted with more than that.
 */
export const DEFAULT_WEIGHTS: ConnectionWeights = {
	connectivity: 0.4,
	sizeClass: 0.15,
	detour: 0.45
};

/** Onward route counts saturate here: a candidate with 20+ known onward destinations is
 * already "clearly not a dead end", and counting higher than that stops distinguishing
 * anything a traveller would notice. */
const CONNECTIVITY_SATURATION = 20;

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
		}
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

/**
 * Combines connectivity, size class and (when geography is known) detour into one score.
 * Returns `null` when the candidate should be excluded outright — currently only the
 * detour-too-large case, and only when geography for A, B and the candidate are all
 * known; an unknown candidate is scored without that component rather than assumed to be
 * a bad detour, since "we don't know" and "we know it's bad" are different things and
 * only the second should disqualify anything (AGENTS.md: "say what you do not know
 * rather than guessing").
 */
function scoreCandidate({
	outDegree,
	candidateGeo,
	originGeo,
	destinationGeo,
	weights,
	maxDetourRatio
}: {
	outDegree: number;
	candidateGeo: ConnectionAirportInfo | undefined;
	originGeo: ConnectionAirportInfo | undefined;
	destinationGeo: ConnectionAirportInfo | undefined;
	weights: ConnectionWeights;
	maxDetourRatio: number;
}): ScoredCandidate | null {
	const connectivity = Math.min(1, outDegree / CONNECTIVITY_SATURATION);
	const sizeClass = candidateGeo ? SIZE_CLASS_SCORES[candidateGeo.sizeClass] : 0.5;

	let detour: number | null = null;
	if (candidateGeo && originGeo && destinationGeo) {
		const direct = haversineDistanceKm(originGeo.coordinates, destinationGeo.coordinates);
		if (direct > 0) {
			const viaCandidate =
				haversineDistanceKm(originGeo.coordinates, candidateGeo.coordinates) +
				haversineDistanceKm(candidateGeo.coordinates, destinationGeo.coordinates);
			const ratio = viaCandidate / direct;
			if (ratio > maxDetourRatio) return null;
			detour = Math.max(0, 1 - (ratio - 1) / (maxDetourRatio - 1));
		}
	}

	// Redistribute the detour weight across the remaining components when it's
	// unavailable, so a candidate with no known geography isn't penalised twice over
	// (once for scoring 0 on detour, again for that weight being spent on nothing).
	const usableWeight = weights.connectivity + weights.sizeClass + (detour === null ? 0 : weights.detour);
	const w = {
		connectivity: weights.connectivity / usableWeight,
		sizeClass: weights.sizeClass / usableWeight,
		detour: detour === null ? 0 : weights.detour / usableWeight
	};

	const score = connectivity * w.connectivity + sizeClass * w.sizeClass + (detour ?? 0) * w.detour;
	return { score, breakdown: { connectivity, sizeClass, detour } };
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
	const freeSources: DirectDestinationSource[] = [
		...freeProviders.map((p) => sourceFromProvider(p, providerKeys, effectiveSignal, onProviderResult)),
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

	let candidateCodes = [...outboundEdges.keys()].filter(
		(code) => code !== origin && code !== destination
	);
	if (allowList) {
		// An explicit allow-list narrows the universe rather than replacing it: an
		// allowed airport the origin has no known outbound edge to at all still isn't
		// addressable here without a metered call per allow-listed code just to test
		// reachability, which would defeat "last resort" for a list that could be long.
		// A caller who needs that supplies a provider with better outbound coverage.
		candidateCodes = candidateCodes.filter((code) => allowList.has(code));
	}

	const candidates: ConnectionCandidate[] = [];

	for (const code of candidateCodes) {
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

		const inboundEdges = await unionDirectDestinations(freeSources, code);
		let inboundSourceId = inboundEdges.get(destination);
		let meteredRequestSpent = false;

		if (
			!inboundSourceId &&
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
				for (const c of result.destinations) {
					if (!inboundEdges.has(c)) inboundEdges.set(c, result.sourceId);
				}
				inboundSourceId = result.destinations.includes(destination) ? result.sourceId : undefined;
			}
		}

		if (!inboundSourceId) continue; // No source, free or metered, confirms C -> destination.

		const scored = scoreCandidate({
			outDegree: inboundEdges.size,
			candidateGeo,
			originGeo,
			destinationGeo,
			weights,
			maxDetourRatio
		});
		if (!scored) continue; // Excluded: detour ratio beyond maxDetourRatio.

		candidates.push({
			airportCode: code,
			score: scored.score,
			breakdown: scored.breakdown,
			confirmedBy: { outbound: outboundEdges.get(code)!, inbound: inboundSourceId },
			meteredRequestSpent
		});
	}

	candidates.sort((a, b) => b.score - a.score || a.airportCode.localeCompare(b.airportCode));
	return candidates.slice(0, Math.max(0, maxCandidates));
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
