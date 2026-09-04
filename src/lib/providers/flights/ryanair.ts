/**
 * Ryanair adapter — issue #6. Two jobs, per the issue: give the app something real to show
 * before any key is entered, and give the cross-price-check (issue #17) ground truth,
 * since these fares come from the airline itself rather than an aggregator's copy of them.
 *
 * No key, no signup, no quota (docs/PROVIDERS.md "Keyless sources"). That shapes two
 * choices below that would look wrong for a metered adapter: `estimateSearchOffersCost`
 * always answers 0 (there is no budget to protect), and every cached value here is
 * refetched no more than once per its TTL rather than on every call — see "Why not
 * staleWhileRevalidate" further down for why that still counts as "going through the
 * cache" (src/lib/cache/) even though it doesn't use that module's generator directly.
 *
 * One real limitation worth stating up front: `farfnd/v4/oneWayFares` is a fare *finder*,
 * not a timetable. Given an origin, a destination and a date range, it returns the single
 * cheapest fare in that range — not one row per day. Verified by hand 2026-09-04: widening
 * the range from 20 days to 60 days returned the same one fare. That is still real,
 * ground-truth pricing for a real flight number and date (exactly what issue #17 needs to
 * cross-check an aggregator), just not a full schedule.
 */

import { defineCacheKey, getDefaultStore } from '../../cache';
import type { CacheKey, CacheStore } from '../../cache';
import type { FlightOffer, IataAirportCode } from '../../domain';
import type {
	FlightProvider,
	FlightSearchQuery,
	ProviderContext,
	ProviderError,
	ProviderHealth,
	ProviderId,
	ProviderResult,
	ProviderSource
} from '../types';
import { fetchActiveAirports, fetchDirectDestinations, fetchOneWayFares } from './ryanair-client';
import { buildTimeZoneIndex, mapFaresToFlightOffers, mapRoutesToDestinations } from './ryanair-mapper';
import type { RyanairFetchError, RyanairFetchResult } from './ryanair-types';

/** Keyless and unmetered — no `../budget` cap or wiring applies — but still a real
 * registered adapter id, so it is checked against `ProviderId` (../types.ts, issue #69)
 * like every other adapter's id. */
export const RYANAIR_PROVIDER_ID: ProviderId = 'ryanair';

/** Matches the `Cache-Control: max-age=60, s-maxage=300` Ryanair's own fare-finder
 * endpoint sends (observed 2026-09-04) — short, because a price is only ground truth for
 * as long as it is actually still on sale. */
const FARES_TTL_MS = 5 * 60_000;
/** Ryanair's route network changes seasonally (a base opens or closes), not intraday, so a
 * day-old direct-destinations list is still correct almost always. */
const ROUTES_TTL_MS = 24 * 60 * 60_000;
/** Airport timezones effectively never change. This table is also the biggest payload
 * this adapter fetches (~220 airports), so it is worth refetching far less often than the
 * data that actually needs freshness. */
const AIRPORT_TIME_ZONES_TTL_MS = 7 * 24 * 60 * 60_000;

export interface RyanairProviderOptions {
	/** Overrides the shared IndexedDB-or-memory store. Tests inject a `MemoryCacheStore`
	 * so nothing here touches a real browser API. */
	store?: CacheStore;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures. */
	fetchImpl?: typeof fetch;
}

function source(): ProviderSource {
	return { providerId: RYANAIR_PROVIDER_ID, fetchedAt: new Date().toISOString() };
}

function toProviderError(error: RyanairFetchError): ProviderError {
	switch (error.code) {
		case 'cancelled':
			return { code: 'cancelled', message: error.message };
		case 'network-error':
			return { code: 'network-error', message: error.message, cause: error.cause };
		case 'malformed-response':
			return { code: 'malformed-response', message: error.message, cause: error.cause };
		case 'rate-limited':
			// Ryanair has no RapidAPI-style subscription quota, but its own WAF can still
			// 429 a client that hammers it — `quota-exceeded` is still the right UI
			// treatment ("back off"), even though the cause isn't a metered plan.
			return {
				code: 'quota-exceeded',
				message: error.message,
				status: 429,
				retryAfterSeconds: error.retryAfterSeconds
			};
		case 'http-error':
			return { code: 'unknown', message: error.message, cause: { status: error.status } };
	}
}

async function resolveStore(options: RyanairProviderOptions): Promise<CacheStore> {
	return options.store ?? (await getDefaultStore());
}

/**
 * Why not `staleWhileRevalidate` (src/lib/cache/stale-while-revalidate.ts) for the reads
 * below: that generator is built for progressive UI rendering — it always calls its
 * fetcher, using the cache only to decide whether it also gets to yield an instant
 * "stale" preview first. A `FlightProvider` method resolves a single `ProviderResult`,
 * with no consumer able to observe a first, provisional yield, so draining that generator
 * here would just mean paying for a fresh network call on every duplicate query within a
 * fan-out — the opposite of what caching an unmetered-but-still-real server call should
 * do. Cache-aside against `CacheStore` directly (this function, plus `writeCache` below)
 * still goes through src/lib/cache/ and honours the same TTL/eviction contract; it just
 * skips the "fetch every time" half of that module, which is specific to progressive
 * rendering. A future UI layer that wants the two-phase behaviour can call
 * `staleWhileRevalidate` itself around a query built from `FlightSearchQuery`.
 */
async function readCache<T>(store: CacheStore, key: CacheKey): Promise<T | undefined> {
	const entry = await store.get(key.raw);
	if (entry === undefined) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return entry.value as T;
}

/** Reads whatever is cached under `key` regardless of freshness — used only as a
 * last-resort fallback when we are out of request budget or the network just failed, on
 * the belief that a slightly stale timezone table beats no timezone at all. */
async function readCacheIgnoringTtl<T>(store: CacheStore, key: CacheKey): Promise<T | undefined> {
	const entry = await store.get(key.raw);
	return entry?.value as T | undefined;
}

// Mirrors cache/size.ts's own `estimateByteSize`, which is deliberately not exported from
// src/lib/cache/index.ts (it's an internal detail of the store implementations) — any
// `CacheStore.set` caller needs *some* number for `sizeBytes`, and this is the same
// approach the module uses internally: "close enough to bytes... not billing anyone."
function estimateSizeBytes(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

async function writeCache<T>(store: CacheStore, key: CacheKey, value: T): Promise<void> {
	const now = Date.now();
	await store.set({
		key: key.raw,
		providerId: RYANAIR_PROVIDER_ID,
		value,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		sizeBytes: estimateSizeBytes(value)
	});
}

/**
 * Resolves the IATA-to-IANA-timezone lookup `mapFaresToFlightOffers` needs, spending at
 * most one network request and never more than `remainingBudget` allows.
 *
 * `remainingBudget === undefined` means "no caller-imposed cap" (ProviderContext.maxRequests
 * semantics). When the budget is exhausted, this falls back to a cached table even past
 * its TTL rather than returning nothing — airports do not change timezone, so a week-old
 * entry is still virtually certain to be correct, and the alternative is dropping every
 * offer in the search over it.
 */
async function resolveAirportTimeZones(
	ctx: ProviderContext,
	store: CacheStore,
	fetchImpl: typeof fetch | undefined,
	remainingBudget: number | undefined
): Promise<{ zones: Record<string, string>; requestsUsed: number }> {
	const key = defineCacheKey(RYANAIR_PROVIDER_ID, { op: 'airportTimeZones' }, AIRPORT_TIME_ZONES_TTL_MS);

	const fresh = await readCache<Record<string, string>>(store, key);
	if (fresh) return { zones: fresh, requestsUsed: 0 };

	if (remainingBudget !== undefined && remainingBudget < 1) {
		const stale = await readCacheIgnoringTtl<Record<string, string>>(store, key);
		return { zones: stale ?? {}, requestsUsed: 0 };
	}

	const response = await fetchActiveAirports({ signal: ctx.signal, fetchImpl });
	if (!response.ok) {
		const stale = await readCacheIgnoringTtl<Record<string, string>>(store, key);
		return { zones: stale ?? {}, requestsUsed: 1 };
	}

	const zones = buildTimeZoneIndex(response.data);
	await writeCache(store, key, zones);
	return { zones, requestsUsed: 1 };
}

function createRyanairFlightProvider(options: RyanairProviderOptions = {}): FlightProvider {
	async function searchOffers(
		query: FlightSearchQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<FlightOffer[]>> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Ryanair search was cancelled before it started' },
				source: source(),
				requestsUsed: 0
			};
		}

		const store = await resolveStore(options);
		const cacheKey = defineCacheKey(RYANAIR_PROVIDER_ID, { op: 'searchOffers', ...query }, FARES_TTL_MS);

		const cached = await readCache<FlightOffer[]>(store, cacheKey);
		if (cached) {
			return { ok: true, data: cached, source: source(), requestsUsed: 0 };
		}

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			// Out of budget before spending anything: an empty ok result, not an error —
			// ProviderContext.maxRequests documents running out of budget as a partial
			// result, never a failure.
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		}

		const faresResponse = await fetchOneWayFares(
			{
				departureAirportIataCode: query.origin,
				arrivalAirportIataCode: query.destination,
				outboundDepartureDateFrom: query.earliestDeparture,
				outboundDepartureDateTo: query.latestDeparture,
				currency: query.currency
			},
			{ signal: ctx.signal, fetchImpl: options.fetchImpl }
		);
		if (!faresResponse.ok) {
			return { ok: false, error: toProviderError(faresResponse.error), source: source(), requestsUsed: 1 };
		}

		const remainingBudget = ctx.maxRequests === undefined ? undefined : ctx.maxRequests - 1;
		const { zones, requestsUsed: tzRequestsUsed } = await resolveAirportTimeZones(
			ctx,
			store,
			options.fetchImpl,
			remainingBudget
		);

		const offers = mapFaresToFlightOffers(faresResponse.data, zones);
		await writeCache(store, cacheKey, offers);

		return { ok: true, data: offers, source: source(), requestsUsed: 1 + tzRequestsUsed };
	}

	async function listDirectDestinations(
		origin: IataAirportCode,
		ctx: ProviderContext
	): Promise<ProviderResult<IataAirportCode[]>> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Ryanair route lookup was cancelled before it started' },
				source: source(),
				requestsUsed: 0
			};
		}

		const store = await resolveStore(options);
		const cacheKey = defineCacheKey(RYANAIR_PROVIDER_ID, { op: 'listDirectDestinations', origin }, ROUTES_TTL_MS);

		const cached = await readCache<IataAirportCode[]>(store, cacheKey);
		if (cached) {
			return { ok: true, data: cached, source: source(), requestsUsed: 0 };
		}

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		}

		const response = await fetchDirectDestinations(origin, { signal: ctx.signal, fetchImpl: options.fetchImpl });
		if (!response.ok) {
			return { ok: false, error: toProviderError(response.error), source: source(), requestsUsed: 1 };
		}

		const destinations = mapRoutesToDestinations(response.data);
		await writeCache(store, cacheKey, destinations);
		return { ok: true, data: destinations, source: source(), requestsUsed: 1 };
	}

	async function healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Ryanair health check was cancelled' },
				source: source(),
				requestsUsed: 0
			};
		}

		// Deliberately bypasses the cache: a health check exists to answer "is Ryanair
		// reachable right now," and a cached "yes" from an hour ago would defeat that.
		// Cheap enough to run rarely (per ProviderBase.healthCheck's own warning against
		// calling it before every search) since it is the same request this adapter would
		// make anyway on the first uncached call to either other method.
		const response = await fetchActiveAirports({ signal: ctx.signal, fetchImpl: options.fetchImpl });
		if (!response.ok) {
			return { ok: false, error: toProviderError(response.error), source: source(), requestsUsed: 1 };
		}
		if (response.data.length === 0) {
			return {
				ok: false,
				error: { code: 'malformed-response', message: 'Ryanair returned zero active airports' },
				source: source(),
				requestsUsed: 1
			};
		}
		return {
			ok: true,
			data: { message: `${response.data.length} active Ryanair airports reachable` },
			source: source(),
			requestsUsed: 1
		};
	}

	return {
		kind: 'flight',
		id: RYANAIR_PROVIDER_ID,
		label: 'Ryanair (no key required)',
		needsKey: false,
		keyFields: [],
		healthCheck,
		// Ryanair is keyless and has no published rate limit, so it never has a budget to
		// protect — reporting 0 is also the exact signal the search pipeline (issue #22)
		// uses to prefer this adapter over a metered one before spending any of its quota.
		estimateSearchOffersCost: () => 0,
		searchOffers,
		listDirectDestinations
	};
}

export { createRyanairFlightProvider };

/** The production singleton: real global `fetch`, the shared default cache store. Import
 * this to register the adapter; use `createRyanairFlightProvider` directly only to inject
 * test doubles. */
export const ryanairFlightProvider: FlightProvider = createRyanairFlightProvider();
