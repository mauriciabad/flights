/**
 * Issue #121: Ryanair's route graph and airport timezone table as one shipped snapshot,
 * refreshed weekly in CI (scripts/fetch-ryanair-network.mjs,
 * .github/workflows/ryanair-network.yml) and lazy-loaded from the generated JSON here --
 * the same shape as cheap-routes.ts and airports.ts, for a different reason.
 *
 * Travelpayouts is fetched at build time because it sends no CORS headers. Ryanair does
 * send them, so this one is about cost, not reachability: the search asks "what does
 * airport X fly to" once per candidate airport, and a BCN->OTP search sent 80 of those
 * requests to a free, public, unmetered-but-not-unlimited API on every cold cache
 * (measured 2026-09-04). Shipping the answer makes that number zero.
 *
 * The snapshot is the floor, never the ceiling. src/lib/providers/flights/ryanair.ts
 * still refreshes it from the live endpoint through the normal cache (AGENTS.md "stale
 * first, then fresh"), and prefers whichever of the two was fetched more recently.
 */

import type { IataAirportCode } from '$lib/domain';

/**
 * Ryanair's whole network as of `fetchedAt`. Both halves come from the single
 * `/api/views/locate/3/airports/en/active` response, which is why they live on one
 * object: they are the same fetch, they go stale together, and splitting them would mean
 * two cache entries that can disagree about which airports exist.
 */
export interface RyanairNetworkSnapshot {
	/** ISO instant the underlying Ryanair response was read. Used to pick between this
	 * snapshot and a cached one when both are past their TTL. */
	fetchedAt: string;
	/**
	 * IATA code to the codes it has a direct Ryanair flight to.
	 *
	 * An airport ABSENT from this map is not in Ryanair's network at all -- exactly what
	 * the per-airport routes endpoint spends an HTTP 404 to say (ALG, DUS, EVN, IST and
	 * LED all 404 there; none of them appears here). That absence is an answer, not a
	 * gap, because Ryanair's active-airports response enumerates its entire network in
	 * one call. It is the reason nothing in this app has to ask about a non-Ryanair
	 * airport twice.
	 */
	destinationsByOrigin: Record<string, IataAirportCode[]>;
	/** IATA code to IANA zone name. The fare-finder endpoint dates every flight in local
	 * wall-clock time with no zone attached (AGENTS.md "Timezones"), and this is where
	 * the zone comes from. */
	timeZonesByIataCode: Record<string, string>;
}

let bundledSnapshotPromise: Promise<RyanairNetworkSnapshot> | null = null;

/**
 * Loads the shipped snapshot on first call and memoizes it for the lifetime of the page.
 * A dynamic `import()` of a JSON file is its own chunk under Vite/Rollup, so the 38 KB
 * only downloads once something actually searches -- the same lazy load `loadAirports`
 * and `loadCheapRoutes` use, and still a plain module import, so tests read it under Node
 * with no `fetch` and no dev server.
 */
export function loadBundledRyanairNetwork(): Promise<RyanairNetworkSnapshot> {
	bundledSnapshotPromise ??= import('./ryanair-network.generated.json').then(
		(mod) => mod.default as RyanairNetworkSnapshot
	);
	return bundledSnapshotPromise;
}

/**
 * Every airport reachable directly from `origin` according to `snapshot`, or `[]` when
 * Ryanair does not serve `origin` at all. Never a throw and never `undefined`: "not in
 * the network" and "flies nowhere" are the same answer to the only question the
 * connection graph asks (`algorithm/connections.ts`), and both are the empty list --
 * matching `getAirport`'s "absent, not an error" convention in airports.ts.
 */
export function directDestinationsFrom(
	snapshot: RyanairNetworkSnapshot,
	origin: IataAirportCode
): IataAirportCode[] {
	const code = origin?.trim().toUpperCase();
	if (!code) return [];
	return snapshot.destinationsByOrigin[code] ?? [];
}

/**
 * Picks the more recently fetched of two snapshots. Both callers are already past the
 * point where either is fresh, so this is a "least wrong" choice, not a validity check: a
 * device that has not searched in a month can easily hold an older snapshot than the one
 * CI regenerated the night before the running build shipped, and the reverse is just as
 * ordinary for a phone with a month-old service-worker cache.
 *
 * An unparseable `fetchedAt` on either side loses, since a snapshot that cannot say how
 * old it is cannot be argued to be the newer one.
 */
export function newerSnapshot(
	a: RyanairNetworkSnapshot,
	b: RyanairNetworkSnapshot
): RyanairNetworkSnapshot {
	const aTime = Date.parse(a.fetchedAt);
	const bTime = Date.parse(b.fetchedAt);
	if (!Number.isFinite(aTime)) return b;
	if (!Number.isFinite(bTime)) return a;
	return aTime >= bTime ? a : b;
}
