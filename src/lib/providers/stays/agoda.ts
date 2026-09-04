/**
 * Agoda adapter — issue #10. The generous half of the pair (`docs/PROVIDERS.md`: 500
 * requests/month, "the outlier and worth exploiting"), which shapes every budget default
 * below: this adapter can afford to drill into several candidate properties per search,
 * where booking.ts (50/month) can only afford one or two. That asymmetry is the whole
 * reason the issue asks for Agoda as the default and Booking as a supplement, not two
 * interchangeable adapters called the same way.
 *
 * Two real limitations shape the code, both found live (2026-09-04, see the PR body for
 * the exact requests) rather than assumed:
 *
 * 1. Agoda's search takes a free-text place name, not a coordinate or radius — see
 *    agoda-client.ts's header for the "location cannot be empty" response that proves it,
 *    and why this adapter reverse-geocodes through Nominatim before ever calling Agoda.
 * 2. Its search response prices a property once, not per room kind — getting a separate
 *    dorm and private price (issue #10's core ask) needs one `get-prices` request PER
 *    property investigated, which is why this file ranks candidates cheapest-first before
 *    spending any of those follow-up requests, exactly like ryanair.ts ranks before
 *    spending its own budget.
 *
 * File split mirrors ryanair.ts: agoda-client.ts (network), agoda-types.ts (raw shapes),
 * agoda-geo.ts (radius maths), agoda-mapper.ts (pure translation to domain shapes), this
 * file (orchestration, caching, budget).
 */

import { defineCacheKey, getDefaultStore } from '../../cache';
import type { CacheKey, CacheStore } from '../../cache';
import { DEFAULT_TRAVELLERS } from '../../domain';
import type { Coordinates, Stay } from '../../domain';
import { callProviderWithBudget } from '../budget';
import { classifyClientResultError, unwrapOrThrow } from '../client-result-budget';
import type {
	ProviderContext,
	ProviderError,
	ProviderHealth,
	ProviderId,
	ProviderResult,
	ProviderSource,
	StayProvider,
	StaySearchQuery
} from '../types';
import {
	fetchGetPrices,
	fetchOvernightStaysSearch,
	fetchReverseGeocode,
	type AgodaFetchError
} from './agoda-client';
import {
	agodaCurrencyId,
	filterWithinRadius,
	mapGetPricesToStays,
	mapSearchPropertyToCandidate,
	resolveLocationLabel,
	type AgodaCandidate
} from './agoda-mapper';

/** Also the id `../budget/caps.ts`'s `DEFAULT_PROVIDER_CAPS` is keyed by — enforced at
 * compile time by `ProviderId` (../types.ts, issue #69), not by convention. */
export const AGODA_PROVIDER_ID: ProviderId = 'agoda';

/** How many cheapest-ranked candidates this adapter will spend a `get-prices` request
 * drilling into per search. Five properties is comfortably enough alternatives to
 * populate a picker (issue #10) while keeping a single search's worst case (1 search + 1
 * currency-table-free lookup + 5 drill-downs = 6 requests) a small fraction of the
 * 500/month quota — see this file's header for why Agoda can afford more of these than
 * booking.ts affords. */
const MAX_CANDIDATES_TO_EXPAND = 5;

/** Hotel prices don't move within a browsing session the way a fare-finder's fares do
 * (ryanair.ts uses 5 minutes for those); an hour is generous enough that re-running a
 * search while comparing connections doesn't spend a second request on either endpoint. */
const SEARCH_TTL_MS = 60 * 60_000;
const PRICES_TTL_MS = 60 * 60_000;
/** Coordinates round to this many degrees (~1.1km at the equator) before being used as a
 * reverse-geocode cache key, and the result is kept for a month: which town or city a
 * point falls inside does not change, so there is no reason to ever refetch a route this
 * app has already resolved once. */
const GEOCODE_TTL_MS = 30 * 24 * 60 * 60_000;
const GEOCODE_COORDINATE_PRECISION = 100; // 1 / 0.01 degrees

export interface AgodaProviderOptions {
	/** Overrides the shared IndexedDB-or-memory store. Tests inject a `MemoryCacheStore`
	 * so nothing here touches a real browser API. */
	store?: CacheStore;
	/** Overrides the global `fetch` for BOTH hosts this adapter calls (RapidAPI and
	 * Nominatim) — tests key their stub by URL, same pattern as ryanair.test.ts. */
	fetchImpl?: typeof fetch;
	/** Overrides `callProviderWithBudget`'s stored/default monthly cap. Mainly for tests —
	 * see `CallProviderWithBudgetOptions.cap` (../budget/call-with-budget.ts). */
	cap?: number;
	/** Overrides the real timer-based backoff delay. Tests pass an instant no-op so a
	 * 429-retry test doesn't take real seconds. */
	sleep?: (ms: number) => Promise<void>;
	/** Overrides `Date.now`. Mainly for tests. */
	now?: () => number;
}

function source(): ProviderSource {
	return { providerId: AGODA_PROVIDER_ID, fetchedAt: new Date().toISOString() };
}

function toProviderError(error: AgodaFetchError): ProviderError {
	switch (error.code) {
		case 'cancelled':
			return { code: 'cancelled', message: error.message };
		case 'network-error':
			return { code: 'network-error', message: error.message, cause: error.cause };
		case 'malformed-response':
			return { code: 'malformed-response', message: error.message, cause: error.cause };
		case 'not-subscribed':
			return { code: 'not-subscribed', message: error.message, status: 403 };
		case 'rate-limited':
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

async function resolveStore(options: AgodaProviderOptions): Promise<CacheStore> {
	return options.store ?? (await getDefaultStore());
}

// Cache-aside against CacheStore directly, not staleWhileRevalidate — same reasoning as
// ryanair.ts's identically-named helpers: a StayProvider method resolves one
// ProviderResult with no consumer able to observe a progressive first yield.
async function readCache<T>(store: CacheStore, key: CacheKey): Promise<T | undefined> {
	const entry = await store.get(key.raw);
	if (entry === undefined) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return entry.value as T;
}

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
		providerId: AGODA_PROVIDER_ID,
		value,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		sizeBytes: estimateSizeBytes(value)
	});
}

function roundCoordinate(value: number): number {
	return Math.round(value * GEOCODE_COORDINATE_PRECISION) / GEOCODE_COORDINATE_PRECISION;
}

/** Resolves a coordinate to the "City, Country" text Agoda's search needs, spending at
 * most one Nominatim request (never counted in `requestsUsed` — that field tracks this
 * adapter's own RapidAPI spend, and Nominatim is a separate, free, unmetered host; see
 * agoda-client.ts's header). Returns `undefined` rather than throwing when Nominatim has
 * no address for the point (open ocean, etc.) or the request itself fails — either way
 * this adapter has nothing to search Agoda with, which agoda.ts's caller treats as "no
 * results here" rather than an error, per AGENTS.md "partial results are the normal
 * case." */
async function resolveLocation(
	near: Coordinates,
	store: CacheStore,
	signal: AbortSignal,
	fetchImpl: typeof fetch | undefined
): Promise<string | undefined> {
	const key = defineCacheKey(
		AGODA_PROVIDER_ID,
		{ op: 'reverseGeocode', lat: roundCoordinate(near.latitude), lon: roundCoordinate(near.longitude) },
		GEOCODE_TTL_MS
	);
	const cached = await readCache<string | null>(store, key);
	if (cached !== undefined) return cached ?? undefined;

	const response = await fetchReverseGeocode(near, { signal, fetchImpl });
	if (!response.ok) return undefined;

	const label = resolveLocationLabel(response.data.address ?? {});
	// Cache a resolved `null` too, not just a hit: a coordinate with no nearby address is
	// just as stable a fact as one that resolves, and re-querying Nominatim for the same
	// empty ocean point on every search would defeat the whole point of caching it.
	await writeCache(store, key, label ?? null);
	return label;
}

function createAgodaStayProvider(options: AgodaProviderOptions = {}): StayProvider {
	function budgetCall<T>(dedupeKey: string, execute: () => Promise<T>): Promise<ProviderResult<T>> {
		return callProviderWithBudget({
			providerId: AGODA_PROVIDER_ID,
			dedupeKey,
			execute,
			classifyError: classifyClientResultError,
			cap: options.cap,
			sleep: options.sleep,
			now: options.now
		});
	}

	async function searchStays(query: StaySearchQuery, ctx: ProviderContext): Promise<ProviderResult<Stay[]>> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Agoda search was cancelled before it started' },
				source: source(),
				requestsUsed: 0
			};
		}
		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return {
				ok: false,
				error: { code: 'missing-key', message: 'No RapidAPI key configured for Agoda' },
				source: source(),
				requestsUsed: 0
			};
		}

		const store = await resolveStore(options);

		const locationLabel = await resolveLocation(query.near, store, ctx.signal, options.fetchImpl);
		if (!locationLabel) {
			// Could not place these coordinates on a map at all (or Nominatim is
			// unreachable) — Agoda cannot be searched without a place name, but this is a
			// "nothing found here" outcome, not a failed call: no Agoda request was ever
			// spent trying.
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		}

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		}

		const travellers = query.travellers ?? DEFAULT_TRAVELLERS;
		const currencyId = agodaCurrencyId(query.currency);

		const searchCacheKey = defineCacheKey(
			AGODA_PROVIDER_ID,
			{ op: 'search', locationLabel, checkIn: query.checkIn, checkOut: query.checkOut },
			SEARCH_TTL_MS
		);

		let candidates = await readCache<AgodaCandidate[]>(store, searchCacheKey);
		let requestsUsed = 0;

		if (!candidates) {
			const searchResult = await budgetCall(
				`${AGODA_PROVIDER_ID}:search:${locationLabel}:${query.checkIn}:${query.checkOut}`,
				() =>
					unwrapOrThrow(
						fetchOvernightStaysSearch(
							{ location: locationLabel, checkinDate: query.checkIn, checkoutDate: query.checkOut },
							{ signal: ctx.signal, apiKey, fetchImpl: options.fetchImpl }
						),
						toProviderError
					)
			);
			requestsUsed += searchResult.requestsUsed;
			if (!searchResult.ok) {
				return { ok: false, error: searchResult.error, source: source(), requestsUsed };
			}
			const properties = searchResult.data.data?.properties ?? [];
			candidates = [];
			for (const property of properties) {
				const candidate = mapSearchPropertyToCandidate(property);
				if (candidate) candidates.push(candidate);
			}
			await writeCache(store, searchCacheKey, candidates);
		}

		const withinRadius = filterWithinRadius(candidates, query.near, query.radiusKm);
		const cheapestFirst = [...withinRadius].sort((a, b) => a.headlinePrice.minorUnits - b.headlinePrice.minorUnits);

		const remainingBudget = ctx.maxRequests === undefined ? undefined : ctx.maxRequests - requestsUsed;
		const drillLimit =
			remainingBudget === undefined ? MAX_CANDIDATES_TO_EXPAND : Math.max(0, Math.min(MAX_CANDIDATES_TO_EXPAND, remainingBudget));
		const toExpand = cheapestFirst.slice(0, drillLimit);

		const stays: Stay[] = [];
		for (const candidate of toExpand) {
			// A cancellation partway through drilling into candidates keeps whatever
			// Stay records already came back rather than discarding them — the same
			// "partial result, not a failure" treatment ctx.maxRequests exhaustion gets
			// below, since a caller that cares whether this was cut short can already see
			// that from its own AbortSignal.
			if (ctx.signal.aborted) break;

			const pricesCacheKey = defineCacheKey(
				AGODA_PROVIDER_ID,
				{ op: 'getPrices', propertyId: candidate.propertyId, checkIn: query.checkIn, checkOut: query.checkOut, travellers, currencyId },
				PRICES_TTL_MS
			);
			let candidateStays = await readCache<Stay[]>(store, pricesCacheKey);
			if (!candidateStays) {
				const pricesResult = await budgetCall(
					`${AGODA_PROVIDER_ID}:getPrices:${candidate.propertyId}:${query.checkIn}:${query.checkOut}:${travellers}:${currencyId}`,
					() =>
						unwrapOrThrow(
							fetchGetPrices(
								{ propertyId: candidate.propertyId, checkinDate: query.checkIn, checkoutDate: query.checkOut, adults: travellers, currencyId },
								{ signal: ctx.signal, apiKey, fetchImpl: options.fetchImpl }
							),
							toProviderError
						)
				);
				requestsUsed += pricesResult.requestsUsed;
				if (!pricesResult.ok) {
					// One property's drill-down failing must not sink the whole search —
					// the same "one provider failing must never fail a search" contract
					// types.ts asks of adapters as a whole, applied one level down to a
					// single candidate within this adapter.
					continue;
				}
				candidateStays = mapGetPricesToStays(candidate.property, pricesResult.data);
				await writeCache(store, pricesCacheKey, candidateStays);
			}
			stays.push(...candidateStays);
		}

		const filtered = query.roomKinds ? stays.filter((s) => query.roomKinds?.includes(s.roomKind)) : stays;
		filtered.sort((a, b) => a.pricePerNight.minorUnits - b.pricePerNight.minorUnits);

		return { ok: true, data: filtered, source: source(), requestsUsed };
	}

	function estimateSearchStaysCost(): number {
		// Worst case: one search plus a `get-prices` drill-down for every candidate this
		// adapter would consider — see MAX_CANDIDATES_TO_EXPAND's comment. The reverse-geocode
		// step is not counted here because it never touches Agoda's own metered surface.
		return 1 + MAX_CANDIDATES_TO_EXPAND;
	}

	async function healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Agoda health check was cancelled' },
				source: source(),
				requestsUsed: 0
			};
		}
		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return {
				ok: false,
				error: { code: 'missing-key', message: 'No RapidAPI key configured for Agoda' },
				source: source(),
				requestsUsed: 0
			};
		}
		// A generic, always-populated city rather than the caller's own query: this is a
		// "can this key reach Agoda at all" check (ProviderBase.healthCheck's own warning
		// against calling it before every search already keeps this rare), not a
		// pre-warm of any particular search.
		const result = await budgetCall(`${AGODA_PROVIDER_ID}:healthCheck`, () =>
			unwrapOrThrow(
				fetchOvernightStaysSearch(
					{ location: 'Paris, France', checkinDate: nearFutureDate(30), checkoutDate: nearFutureDate(32) },
					{ signal: ctx.signal, apiKey, fetchImpl: options.fetchImpl }
				),
				toProviderError
			)
		);
		if (!result.ok) {
			return { ok: false, error: result.error, source: source(), requestsUsed: result.requestsUsed };
		}
		const count = result.data.data?.properties?.length ?? 0;
		if (count === 0) {
			return {
				ok: false,
				error: { code: 'malformed-response', message: 'Agoda returned zero properties for a known city' },
				source: source(),
				requestsUsed: result.requestsUsed
			};
		}
		return {
			ok: true,
			data: { message: `${count} Agoda properties reachable` },
			source: source(),
			requestsUsed: result.requestsUsed
		};
	}

	return {
		kind: 'stay',
		id: AGODA_PROVIDER_ID,
		label: 'Agoda (RapidAPI)',
		needsKey: true,
		keyFields: [
			{
				id: 'apiKey',
				label: 'RapidAPI Key',
				placeholder: 'Your RapidAPI key',
				helpUrl: 'https://rapidapi.com/ntd119/api/agoda-com'
			}
		],
		healthCheck,
		estimateSearchStaysCost,
		searchStays
	};
}

function nearFutureDate(daysFromNow: number): string {
	const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60_000);
	return date.toISOString().slice(0, 10);
}

export { createAgodaStayProvider };

/** The production singleton: real global `fetch`, the shared default cache store. Import
 * this to register the adapter; use `createAgodaStayProvider` directly only to inject
 * test doubles. */
export const agodaStayProvider: StayProvider = createAgodaStayProvider();

export type { AgodaCandidate };
