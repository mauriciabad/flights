import { defineCacheKey, getDefaultStore } from '../../cache';
import type { CacheStore } from '../../cache';
import type { FlightsSkyEntity } from './flights-sky-types';

/**
 * Same policy as skyscanner-airport-cache.ts, for the same reason: `skyId`/`entityId` are
 * reference data that changes on the timescale of the catalogue being restructured, not of a
 * fare, so this reads the shared `CacheStore` directly (never `staleWhileRevalidate`, whose
 * "always call the fetcher" contract would spend one of this adapter's 40 monthly requests
 * per search just to re-confirm a code that has not changed since the airport was built).
 *
 * This issue's brief calls out the auto-complete request as one to "cache this hard; it
 * barely changes and must not cost a search request" — this cache is that.
 */

const CACHE_PROVIDER_ID = 'flights-sky';
/** About six months, matching skyscanner-airport-cache.ts's own reasoning: "essentially
 * never changes" does not mean "never." */
const ENTITY_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 180;

function cacheKeyFor(iataCode: string) {
	return defineCacheKey(
		CACHE_PROVIDER_ID,
		{ kind: 'entity', iataCode: iataCode.toUpperCase() },
		ENTITY_CACHE_TTL_MS
	);
}

/** `undefined` on a cold cache or an entry past its TTL. Either way the caller
 * (flights-sky.ts) resolves the entity over the network and calls `setCachedEntity`. */
export async function getCachedEntity(
	iataCode: string,
	store?: CacheStore
): Promise<FlightsSkyEntity | undefined> {
	const cacheStore = store ?? (await getDefaultStore());
	const entry = await cacheStore.get(cacheKeyFor(iataCode).raw);
	if (entry === undefined) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return entry.value as FlightsSkyEntity;
}

export async function setCachedEntity(
	iataCode: string,
	entity: FlightsSkyEntity,
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
		sizeBytes: JSON.stringify(entity).length
	});
}

/**
 * Picks the entry whose `skyId` matches `iataCode` exactly, case-insensitively, and never
 * the first result. This issue and docs/PROVIDERS.md both call out the same live trap:
 * `auto-complete?query=barcelona` answers with Barcelona, Spain (`skyId: "BCN"`) AND
 * Barcelona, Venezuela (`skyId: "BLA"`) — captured for real in
 * ./fixtures/flights-sky-auto-complete-barcelona.json. Taking `data[0]` would work today,
 * by luck of ordering, and mis-route a search the day that ordering changes.
 */
export function extractExactEntityMatch(raw: unknown, iataCode: string): FlightsSkyEntity | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.data)) return undefined;
	for (const item of raw.data) {
		if (!isRecord(item) || !isRecord(item.navigation)) continue;
		const params = item.navigation.relevantFlightParams;
		if (!isRecord(params)) continue;
		const { skyId, entityId } = params;
		if (
			typeof skyId === 'string' &&
			skyId.toUpperCase() === iataCode.toUpperCase() &&
			typeof entityId === 'string'
		) {
			return { skyId, entityId };
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}
