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
 * search one, so it spends nothing metered itself unless explicitly told it may (see
 * `meteredSource` below), and even then only as a last resort for candidates the caller
 * named explicitly.
 *
 * Sources, cheapest first (brief line 73: "Get flight connections (flightconnections.com
 * or similar)"):
 *   1. A keyless, unlimited route-graph source — Ryanair's own route endpoint
 *      (`https://www.ryanair.com/api/views/locate/searchWidget/routes/en/airport/{IATA}`).
 *      Another agent is building that adapter (issue #2's `FlightProvider.listDirectDestinations`,
 *      not merged into main as of this writing). This file does not import it: it defines
 *      the narrow `DirectDestinationSource` shape below instead, so wiring the real
 *      adapter in later is a one-line call-site change, not a rewrite. See "Follow-up"
 *      at the bottom of this file.
 *   2. `FALLBACK_ROUTES` (./connections-fallback-data.ts), a small bundled table, always
 *      included so first paint and offline both produce a plausible answer.
 *   3. `meteredSource`, a metered aggregator's own "direct destinations from X" call
 *      (docs/prompts/004: "the Skyscanner adapter's direct-destination call"). Never used
 *      unless the caller supplies both a source AND a positive `meteredRequestBudget` —
 *      the two places this module would ever spend one are marked "SPENDS A METERED
 *      REQUEST" below, and both are last resorts for cases the free sources could not
 *      resolve.
 */

import type {
	AirportSizeClass,
	Coordinates,
	IataAirportCode,
	IsoCountryCode,
	SearchQuery
} from '../domain';
import { FALLBACK_AIRPORTS, FALLBACK_ROUTES } from './connections-fallback-data';

/**
 * The only thing this module needs from a route-graph adapter: given an airport, which
 * airports does it fly to directly. Deliberately narrower than issue #2's `FlightProvider`
 * (which wraps this in `ProviderResult`, an `AbortSignal`-carrying `ProviderContext`, and
 * request-cost accounting of its own) — this file has no dependency on that interface
 * existing, and a caller who does have a real `FlightProvider` adapts it in one line:
 * `{ id: 'ryanair', getDirectDestinations: (code, signal) =>
 *     ryanair.listDirectDestinations(code, { signal }).then(r => r.ok ? r.data : []) }`.
 */
export interface DirectDestinationSource {
	/** Stable id, surfaced on each candidate's `confirmedBy` so a wrong candidate can be
	 * traced back to the source that vouched for it. */
	readonly id: string;
	getDirectDestinations(
		iataCode: IataAirportCode,
		signal?: AbortSignal
	): Promise<IataAirportCode[]>;
}

/** What this module needs to rank a candidate: where it is, how big it is, and which
 * country it's in (for the forbidden-country filter). A subset of the domain `Airport`
 * shape on purpose, so a real airport dataset (issue #11, not merged into main as of this
 * writing) can satisfy this with `{ coordinates: a.coordinates, sizeClass: a.sizeClass,
 * countryCode: a.country.isoCode }` once it exists, without this file importing it. */
export interface ConnectionAirportInfo {
	coordinates: Coordinates;
	sizeClass: AirportSizeClass;
	countryCode: IsoCountryCode;
}

/** May return synchronously (the bundled fallback table does) or asynchronously (a real
 * dataset lookup would). `undefined` means "this lookup has no record for that code",
 * never a throw — see the graceful-degradation notes on `scoreCandidate` below. */
export type AirportLookup = (
	iataCode: IataAirportCode
) => ConnectionAirportInfo | undefined | Promise<ConnectionAirportInfo | undefined>;

/** Score components before weighting, each in `[0, 1]` (`detour` is `null` when neither
 * `airportLookup` nor the bundled fallback had geography for A, B, or the candidate — see
 * `scoreCandidate`). Exposed mainly so a UI or a test can explain *why* a candidate ranked
 * where it did, rather than trusting a single opaque number. */
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
	/** Which source confirmed each leg — the id from whichever `DirectDestinationSource`
	 * (or `meteredSource`) first reported it, in source-preference order. */
	confirmedBy: { outbound: string; inbound: string };
	/** True when confirming this candidate's `C -> destination` leg spent one of
	 * `meteredRequestBudget`'s requests. Always false when a free source already covered
	 * it, which is the common case. */
	meteredRequestSpent: boolean;
}

/**
 * The subset of `SearchQuery` this module reads. Kept as a `Pick` rather than a bespoke
 * type so the field names, defaults and semantics stay defined in exactly one place
 * (domain/search-query.ts) — this file adds no meaning of its own to any of them.
 */
export type ConnectionQuery = Pick<
	SearchQuery,
	| 'originAirport'
	| 'destinationAirport'
	| 'forbiddenConnectionCountries'
	| 'forbiddenConnectionAirports'
	| 'allowedConnectionAirports'
>;

export interface ConnectionWeights {
	connectivity: number;
	sizeClass: number;
	detour: number;
}

export interface ConnectionGraphOptions {
	/** Keyless/unlimited route-graph sources, most preferred first (e.g. a Ryanair
	 * adapter once one is wired in). `FALLBACK_ROUTES` is always unioned in after these,
	 * so offline and first-paint work even when this is omitted entirely. */
	routeGraphSources?: DirectDestinationSource[];
	/** A metered aggregator's own direct-destination call, used only as a last resort —
	 * see the module doc comment and the two "SPENDS A METERED REQUEST" sites below.
	 * Omit to guarantee this module never spends a metered request, regardless of
	 * `meteredRequestBudget`. */
	meteredSource?: DirectDestinationSource;
	/** Hard ceiling on how many requests `meteredSource` may be called, across this one
	 * call to `findConnectionCandidates`. Default `0`: metered spending is opt-in, never
	 * a silent default, exactly like `ProviderContext.maxRequests` elsewhere in this
	 * codebase (issue #2's provider interface) exists to prevent a "convenient" method
	 * from quietly burning a monthly quota. */
	meteredRequestBudget?: number;
	/** Geography lookup for ranking and the forbidden-country filter. Consulted before
	 * `FALLBACK_AIRPORTS`, so a real dataset (once wired in) takes priority over the
	 * bundled snapshot for any code it actually has. Omit to rank using only the bundled
	 * fallback's ~18 airports; codes outside it degrade as described on `scoreCandidate`. */
	airportLookup?: AirportLookup;
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
 * explicitly. Connectivity and size class both proxy for "would a person actually want to
 * stop here", which matters, but a backwards detour is disqualifying in a way neither of
 * those should be able to outweigh.
 */
export const DEFAULT_WEIGHTS: ConnectionWeights = {
	connectivity: 0.3,
	sizeClass: 0.25,
	detour: 0.45
};

/** Onward route counts saturate here: a candidate with 20+ known onward destinations is
 * already "clearly not a dead end", and counting higher than that stops distinguishing
 * anything a traveller would notice. */
const CONNECTIVITY_SATURATION = 20;

/**
 * Airport size as a (weak, acknowledged) proxy for "somewhere a person would want to
 * spend a few days" — this module has no tourism data to ask that question directly, and
 * a bigger airport at least correlates with a bigger city and more onward options if a
 * flight gets cancelled. Also doubles as a served-well signal in its own right.
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

async function resolveAirportInfo(
	iataCode: IataAirportCode,
	customLookup?: AirportLookup
): Promise<ConnectionAirportInfo | undefined> {
	if (customLookup) {
		const result = await customLookup(iataCode);
		if (result) return result;
	}
	return FALLBACK_AIRPORTS.get(iataCode);
}

/**
 * Queries every source for `iataCode`'s direct destinations and unions the results,
 * keeping the id of whichever source (in `sources` order, i.e. cheapest/most-preferred
 * first) reported each destination first. Union rather than "first source that answers
 * wins" on purpose: these are all free-to-query sources at this point in the algorithm
 * (the metered one is never passed in here — see the two call sites below), so more
 * recall never costs anything, and Ryanair being one airline (docs/prompts/004: "a
 * source that queries one carrier is not acceptable as the primary engine") means it
 * alone would under-count real candidates.
 */
async function unionDirectDestinations(
	sources: DirectDestinationSource[],
	iataCode: IataAirportCode,
	signal?: AbortSignal
): Promise<Map<IataAirportCode, string>> {
	const byCode = new Map<IataAirportCode, string>();
	for (const source of sources) {
		const destinations = await source.getDirectDestinations(iataCode, signal);
		for (const code of destinations) {
			if (!byCode.has(code)) byCode.set(code, source.id);
		}
	}
	return byCode;
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
		routeGraphSources = [],
		meteredSource,
		meteredRequestBudget = 0,
		airportLookup,
		maxCandidates = DEFAULT_MAX_CANDIDATES,
		maxDetourRatio = DEFAULT_MAX_DETOUR_RATIO,
		weights = DEFAULT_WEIGHTS,
		signal
	} = options;

	// The fallback table is always unioned in last so it never shadows a better source's
	// answer, but it always contributes something — this is what "first paint and
	// offline both work" (issue #12) actually means in code.
	const sources = [...routeGraphSources, fallbackRouteSource()];

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
	const outboundEdges = await unionDirectDestinations(sources, origin, signal);

	if (outboundEdges.size === 0 && meteredSource && remainingMeteredBudget > 0) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		// SPENDS A METERED REQUEST: free sources have nothing at all for the origin
		// airport (not even the bundled fallback covers it), so candidate discovery has
		// no other way to start. This runs at most once per call, never once per
		// candidate.
		const destinationsFromOrigin = await meteredSource.getDirectDestinations(origin, signal);
		remainingMeteredBudget -= 1;
		for (const code of destinationsFromOrigin) outboundEdges.set(code, meteredSource.id);
	}

	let candidateCodes = [...outboundEdges.keys()].filter(
		(code) => code !== origin && code !== destination
	);
	if (allowList) {
		// An explicit allow-list narrows the universe rather than replacing it: an
		// allowed airport the origin has no known outbound edge to at all still isn't
		// addressable here without a metered call per allow-listed code just to test
		// reachability, which would defeat "last resort" for a list that could be long.
		// A caller who needs that supplies a source with better outbound coverage.
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

		if (forbiddenCountries.size > 0) {
			// Fail closed: a candidate whose country can't be determined can't be cleared
			// against the forbidden list either, so it's dropped rather than risked. Only
			// applies when a forbidden list was actually given, so a candidate with no
			// geography isn't penalised for a filter that was never in effect.
			if (!candidateGeo || forbiddenCountries.has(candidateGeo.countryCode)) continue;
		}

		const inboundEdges = await unionDirectDestinations(sources, code, signal);
		let inboundSourceId = inboundEdges.get(destination);
		let meteredRequestSpent = false;

		if (!inboundSourceId && meteredSource && remainingMeteredBudget > 0 && allowList?.has(code)) {
			if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
			// SPENDS A METERED REQUEST: only reached for a candidate the caller explicitly
			// allow-listed (so it's known to matter to this search) and only when every
			// free source came back without a C -> destination edge. Never reached during
			// broad, un-allow-listed discovery, where the candidate count could be large
			// enough to burn the whole monthly quota checking reachability alone.
			const destinationsFromCandidate = await meteredSource.getDirectDestinations(code, signal);
			remainingMeteredBudget -= 1;
			meteredRequestSpent = true;
			for (const c of destinationsFromCandidate) {
				if (!inboundEdges.has(c)) inboundEdges.set(c, meteredSource.id);
			}
			inboundSourceId = destinationsFromCandidate.includes(destination) ? meteredSource.id : undefined;
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

/*
 * Follow-up (out of this issue's scope, per AGENTS.md "work only on your issue"):
 *   - Wire a real Ryanair-backed `DirectDestinationSource` into `routeGraphSources` once
 *     issue #2's provider interface and its Ryanair adapter land on main.
 *   - Wire the real airport dataset (issue #11) in as `airportLookup` once it lands, e.g.
 *     `(code) => getAirport(code).then((a) => a && { coordinates: a.coordinates,
 *     sizeClass: a.sizeClass, countryCode: a.country.isoCode })`.
 *   - Wire a metered aggregator's direct-destination call in as `meteredSource` with a
 *     caller-chosen `meteredRequestBudget`, once such an adapter exists.
 */
