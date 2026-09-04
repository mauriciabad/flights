/**
 * Booking.com adapter — issue #10. The tightly-budgeted half of the pair
 * (docs/PROVIDERS.md: 50 requests/month, ten times tighter than Agoda's), which is why
 * this file spends far less per search than agoda.ts does: one search plus, by default,
 * only ONE follow-up `getRoomList` drill-down, versus Agoda's five. Meant to be called as
 * a supplement — a second opinion on a connection the caller already cares about, or a
 * fallback when Agoda has nothing usable near a coordinate — not on every search the way
 * Agoda can afford to be.
 *
 * Unlike Agoda, this adapter needs no reverse-geocoding shim: `searchHotelsByCoordinates`
 * takes a real latitude/longitude/radius (confirmed live 2026-09-04, see the PR body), so
 * `StaySearchQuery.near`/`radiusKm` pass straight through. Its own quirk instead is a
 * price-per-property search result exactly like Agoda's — getting a separate dorm and
 * private price still needs one `getRoomList` request per property, which is the real
 * reason this adapter's budget defaults are so conservative rather than an arbitrary
 * choice.
 *
 * File split mirrors ryanair.ts and agoda.ts: booking-client.ts (network),
 * booking-types.ts (raw shapes), booking-mapper.ts (pure translation to domain shapes),
 * this file (orchestration, caching, budget).
 */

import { defineCacheKey, getDefaultStore } from '../../cache';
import type { CacheKey, CacheStore } from '../../cache';
import { DEFAULT_TRAVELLERS } from '../../domain';
import type { Stay } from '../../domain';
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
import { fetchGetRoomList, fetchSearchHotelsByCoordinates, type BookingHttpDeps } from './booking-client';
import type { BookingFetchError } from './booking-types';
import { mapRoomListToStays, mapSearchResultToCandidate, type BookingCandidate } from './booking-mapper';

/** Also the id `../budget/caps.ts`'s `DEFAULT_PROVIDER_CAPS` is keyed by — enforced at
 * compile time by `ProviderId` (../types.ts, issue #69), not by convention. */
export const BOOKING_PROVIDER_ID: ProviderId = 'booking';

/** Drill-downs per search — see this file's header for why this is a fifth of Agoda's
 * default. Kept at 1 rather than 0 because a search that never drills down could only ever
 * return a property's single headline price with no room-kind attached to it at all,
 * which fails issue #10's actual requirement (dorm and private priced separately) outright
 * rather than just returning fewer alternatives. */
const MAX_CANDIDATES_TO_EXPAND = 1;

/** Same reasoning as agoda.ts's identically-valued constants: hotel prices are stable
 * enough within a browsing session that re-running a search while comparing connections
 * shouldn't spend a second request, and this adapter's tiny monthly budget makes that
 * doubly true here. */
const SEARCH_TTL_MS = 60 * 60_000;
const ROOM_LIST_TTL_MS = 60 * 60_000;

export interface BookingProviderOptions {
	/** Overrides the shared IndexedDB-or-memory store. Tests inject a `MemoryCacheStore`
	 * so nothing here touches a real browser API. */
	store?: CacheStore;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures, so the
	 * whole adapter is exercised with zero real network traffic. */
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
	return { providerId: BOOKING_PROVIDER_ID, fetchedAt: new Date().toISOString() };
}

function toProviderError(error: BookingFetchError): ProviderError {
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

async function resolveStore(options: BookingProviderOptions): Promise<CacheStore> {
	return options.store ?? (await getDefaultStore());
}

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
		providerId: BOOKING_PROVIDER_ID,
		value,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		sizeBytes: estimateSizeBytes(value)
	});
}

function createBookingStayProvider(options: BookingProviderOptions = {}): StayProvider {
	function budgetCall<T>(dedupeKey: string, execute: () => Promise<T>): Promise<ProviderResult<T>> {
		return callProviderWithBudget({
			providerId: BOOKING_PROVIDER_ID,
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
				error: { code: 'cancelled', message: 'Booking search was cancelled before it started' },
				source: source(),
				requestsUsed: 0
			};
		}
		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return {
				ok: false,
				error: { code: 'missing-key', message: 'No RapidAPI key configured for Booking' },
				source: source(),
				requestsUsed: 0
			};
		}
		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		}

		const store = await resolveStore(options);
		const travellers = query.travellers ?? DEFAULT_TRAVELLERS;
		const httpDeps: BookingHttpDeps = { signal: ctx.signal, apiKey, fetchImpl: options.fetchImpl };

		const searchCacheKey = defineCacheKey(
			BOOKING_PROVIDER_ID,
			{
				op: 'search',
				lat: query.near.latitude,
				lon: query.near.longitude,
				radiusKm: query.radiusKm,
				checkIn: query.checkIn,
				checkOut: query.checkOut,
				currency: query.currency
			},
			SEARCH_TTL_MS
		);

		let candidates = await readCache<BookingCandidate[]>(store, searchCacheKey);
		let requestsUsed = 0;

		if (!candidates) {
			const searchResult = await budgetCall(
				`${BOOKING_PROVIDER_ID}:search:${query.near.latitude}:${query.near.longitude}:${query.radiusKm}:${query.checkIn}:${query.checkOut}`,
				() =>
					unwrapOrThrow(
						fetchSearchHotelsByCoordinates(
							{
								latitude: query.near.latitude,
								longitude: query.near.longitude,
								radiusKm: query.radiusKm,
								checkinDate: query.checkIn,
								checkoutDate: query.checkOut,
								currencyCode: query.currency
							},
							httpDeps
						),
						toProviderError
					)
			);
			requestsUsed += searchResult.requestsUsed;
			if (!searchResult.ok) {
				return { ok: false, error: searchResult.error, source: source(), requestsUsed };
			}
			const results = searchResult.data.data?.result ?? [];
			candidates = [];
			for (const result of results) {
				const candidate = mapSearchResultToCandidate(result);
				if (candidate) candidates.push(candidate);
			}
			await writeCache(store, searchCacheKey, candidates);
		}

		const cheapestFirst = [...candidates].sort((a, b) => a.headlinePrice.minorUnits - b.headlinePrice.minorUnits);

		const remainingBudget = ctx.maxRequests === undefined ? undefined : ctx.maxRequests - requestsUsed;
		const drillLimit =
			remainingBudget === undefined ? MAX_CANDIDATES_TO_EXPAND : Math.max(0, Math.min(MAX_CANDIDATES_TO_EXPAND, remainingBudget));
		const toExpand = cheapestFirst.slice(0, drillLimit);

		const stays: Stay[] = [];
		for (const candidate of toExpand) {
			// Same "keep a partial result rather than discard it" choice agoda.ts makes —
			// see its identical check for the full reasoning.
			if (ctx.signal.aborted) break;

			const roomListCacheKey = defineCacheKey(
				BOOKING_PROVIDER_ID,
				{ op: 'getRoomList', hotelId: candidate.hotelId, checkIn: query.checkIn, checkOut: query.checkOut, travellers, currency: query.currency },
				ROOM_LIST_TTL_MS
			);
			let candidateStays = await readCache<Stay[]>(store, roomListCacheKey);
			if (!candidateStays) {
				const roomListResult = await budgetCall(
					`${BOOKING_PROVIDER_ID}:getRoomList:${candidate.hotelId}:${query.checkIn}:${query.checkOut}:${travellers}:${query.currency}`,
					() =>
						unwrapOrThrow(
							fetchGetRoomList(
								{ hotelId: candidate.hotelId, checkinDate: query.checkIn, checkoutDate: query.checkOut, adults: travellers, currencyCode: query.currency },
								httpDeps
							),
							toProviderError
						)
				);
				requestsUsed += roomListResult.requestsUsed;
				if (!roomListResult.ok) {
					// One property's drill-down failing must not sink the whole search —
					// same reasoning as agoda.ts.
					continue;
				}
				candidateStays = mapRoomListToStays(candidate.property, roomListResult.data);
				await writeCache(store, roomListCacheKey, candidateStays);
			}
			stays.push(...candidateStays);
		}

		const filtered = query.roomKinds ? stays.filter((s) => query.roomKinds?.includes(s.roomKind)) : stays;
		filtered.sort((a, b) => a.pricePerNight.minorUnits - b.pricePerNight.minorUnits);

		return { ok: true, data: filtered, source: source(), requestsUsed };
	}

	function estimateSearchStaysCost(): number {
		// Worst case: one search plus a `getRoomList` drill-down for every candidate this
		// adapter would consider — see MAX_CANDIDATES_TO_EXPAND's comment for why that
		// number is deliberately far smaller than agoda.ts's.
		return 1 + MAX_CANDIDATES_TO_EXPAND;
	}

	async function healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Booking health check was cancelled' },
				source: source(),
				requestsUsed: 0
			};
		}
		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return {
				ok: false,
				error: { code: 'missing-key', message: 'No RapidAPI key configured for Booking' },
				source: source(),
				requestsUsed: 0
			};
		}
		// Paris city centre, generously radius'd — a location this adapter's own search
		// has already been confirmed live to return real results for, used only to check
		// "can this key reach Booking at all" (ProviderBase.healthCheck's own warning
		// against calling this before every search already keeps it rare). Spends real
		// quota every time it runs, same trade-off ryanair.ts and agoda.ts accept for
		// their own health checks.
		const result = await budgetCall(`${BOOKING_PROVIDER_ID}:healthCheck`, () =>
			unwrapOrThrow(
				fetchSearchHotelsByCoordinates(
					{
						latitude: 48.8566,
						longitude: 2.3522,
						radiusKm: 15,
						checkinDate: nearFutureDate(30),
						checkoutDate: nearFutureDate(32)
					},
					{ signal: ctx.signal, apiKey, fetchImpl: options.fetchImpl }
				),
				toProviderError
			)
		);
		if (!result.ok) {
			return { ok: false, error: result.error, source: source(), requestsUsed: result.requestsUsed };
		}
		const count = result.data.data?.result?.length ?? 0;
		if (count === 0) {
			return {
				ok: false,
				error: { code: 'malformed-response', message: 'Booking returned zero hotels for a known city' },
				source: source(),
				requestsUsed: result.requestsUsed
			};
		}
		return {
			ok: true,
			data: { message: `${count} Booking hotels reachable` },
			source: source(),
			requestsUsed: result.requestsUsed
		};
	}

	return {
		kind: 'stay',
		id: BOOKING_PROVIDER_ID,
		label: 'Booking.com (RapidAPI)',
		needsKey: true,
		keyFields: [
			{
				id: 'apiKey',
				label: 'RapidAPI Key',
				placeholder: 'Your RapidAPI key',
				helpUrl: 'https://rapidapi.com/DataCrawler/api/booking-com15'
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

export { createBookingStayProvider };

/** The production singleton: real global `fetch`, the shared default cache store. Import
 * this to register the adapter; use `createBookingStayProvider` directly only to inject
 * test doubles. */
export const bookingStayProvider: StayProvider = createBookingStayProvider();

export type { BookingCandidate };
