import { defineCacheKey, getDefaultStore } from '../../cache';
import type { CacheStore } from '../../cache';

/**
 * Sky Scrapper prices flights by its own numeric `entityId`, not by IATA code (the brief's
 * "searchAirport" call in issue #5: BCN resolves to entity id 95565085). That id is
 * reference data, not a search result. It changes on the timescale of Skyscanner
 * restructuring its own catalogue, not on the timescale of a fare, so it needs a cache
 * policy different from every other value this adapter fetches: never revalidate on a
 * schedule, only refetch on an outright miss or an expiry measured in months.
 *
 * This deliberately does not use `staleWhileRevalidate` (cache/stale-while-revalidate.ts),
 * even though that is the pattern the rest of this app follows (AGENTS.md: "stale first,
 * then fresh"). That generator's contract is "always call the fetcher," which is exactly
 * right for a fare that can move by the hour and exactly wrong here: an airport lookup on
 * every call would spend one of this adapter's 20 monthly requests per search just to
 * re-confirm a code that has not changed since the airport was built. So this reads the
 * shared `CacheStore` directly and only calls out to Sky Scrapper on a genuine miss or
 * expiry, using the exact same store `getDefaultStore()` gives everything else (issue #4),
 * not a cache of its own.
 */

export interface SkyscannerAirportEntity {
	skyId: string;
	entityId: string;
}

const CACHE_PROVIDER_ID = 'skyscanner';
/** About six months. "Essentially never changes" (issue #5) does not mean "never," so a
 * long TTL is kept rather than none, in case Skyscanner ever retires or renumbers an id. */
const AIRPORT_ENTITY_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 180;

function cacheKeyFor(iataCode: string) {
	return defineCacheKey(
		CACHE_PROVIDER_ID,
		{ kind: 'airport-entity', iataCode: iataCode.toUpperCase() },
		AIRPORT_ENTITY_CACHE_TTL_MS
	);
}

/** `undefined` on a cold cache or an entry past its TTL. Either way, the caller
 * (skyscanner.ts) is expected to resolve the entity over the network and call
 * `setCachedAirportEntity` with the result. */
export async function getCachedAirportEntity(
	iataCode: string,
	store?: CacheStore
): Promise<SkyscannerAirportEntity | undefined> {
	const cacheStore = store ?? (await getDefaultStore());
	const entry = await cacheStore.get(cacheKeyFor(iataCode).raw);
	if (entry === undefined) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return entry.value as SkyscannerAirportEntity;
}

export async function setCachedAirportEntity(
	iataCode: string,
	entity: SkyscannerAirportEntity,
	store?: CacheStore
): Promise<void> {
	const cacheStore = store ?? (await getDefaultStore());
	const key = cacheKeyFor(iataCode);
	const now = Date.now();
	await cacheStore.set({
		key: key.raw,
		providerId: key.providerId,
		value: entity,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		sizeBytes: estimateEntitySize(entity)
	});
}

// A local one-liner rather than importing cache/size.ts's estimateByteSize: that function is
// an internal implementation detail of the cache module (cache/index.ts does not export
// it), and an entity record this small (two short strings) does not need the shared
// helper's generality.
function estimateEntitySize(entity: SkyscannerAirportEntity): number {
	return JSON.stringify(entity).length;
}
