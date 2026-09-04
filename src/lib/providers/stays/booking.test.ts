import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import type { CacheStore, StoredCacheEntry } from '../../cache';
import { clearInFlightForTests, clearProviderQuotaStateForTests, resetPermanentFailuresForTests } from '../budget';
import { createBookingStayProvider } from './booking';
import bookingRoomListIbis from './fixtures/booking-room-list-ibis.json';
import bookingSearchVienna from './fixtures/booking-search-vienna.json';

/**
 * Exercises the adapter end to end — cache, mapping, budget and error handling together —
 * with a fake `fetch` that resolves fixtures keyed by URL, so nothing here touches the
 * network. Real network round trips against the live Booking endpoints were done by hand,
 * spending 5 of the adapter's 50-request/month budget; see the PR body for the exact
 * requests and results.
 *
 * Issue #69: this adapter now routes every real request through `callProviderWithBudget`
 * (../budget), which keeps module-level state (in-flight dedup, the permanently-
 * unsubscribed set, and a `localStorage`-backed monthly counter) that must be reset between
 * tests, same as flights-sky.test.ts does.
 */
const instantSleep = async () => {};

const EMPTY_ROOM_LIST = { data: { block: [] } };

let fetchCallCount = 0;
let searchUrlsSeen: string[] = [];

function fixtureFetch(overrides: Record<string, () => Response> = {}): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		fetchCallCount++;
		const url = input.toString();
		for (const [prefix, respond] of Object.entries(overrides)) {
			if (url.startsWith(prefix)) return respond();
		}
		if (url.startsWith('https://booking-com15.p.rapidapi.com/api/v1/hotels/searchHotelsByCoordinates')) {
			searchUrlsSeen.push(url);
			return new Response(JSON.stringify(bookingSearchVienna), { status: 200 });
		}
		if (url.startsWith('https://booking-com15.p.rapidapi.com/api/v1/hotels/getRoomList')) {
			const hotelId = new URL(url).searchParams.get('hotel_id');
			const body = hotelId === '71662' ? bookingRoomListIbis : EMPTY_ROOM_LIST;
			return new Response(JSON.stringify(body), { status: 200 });
		}
		throw new Error(`fixtureFetch: no stub configured for ${url}`);
	}) as typeof fetch;
}

const query = {
	near: { latitude: 48.1103, longitude: 16.5697 }, // VIE airport coordinates
	radiusKm: 25,
	checkIn: '2026-10-10',
	checkOut: '2026-10-12'
};

const apiKeys = { apiKey: 'test-key' };

const MINUTE_MS = 60_000;

/**
 * A cache store whose entries can be back-dated once they are written. Seeding a cache hit
 * by hand would mean rebuilding the adapter's hashed cache keys (`defineCacheKey`) inside
 * the test, which rots silently the moment one of those keys gains a field; warming the
 * cache through a real fixture-fed search and then rewinding `storedAt` ages whatever keys
 * the adapter actually writes.
 */
class RewindableCacheStore implements CacheStore {
	private readonly entries = new Map<string, StoredCacheEntry>();
	/** Keys in the order the adapter first wrote them: the search, then one per drill-down. */
	readonly writeOrder: string[] = [];

	async get(key: string): Promise<StoredCacheEntry | undefined> {
		const entry = this.entries.get(key);
		return entry ? { ...entry } : undefined;
	}

	async set(entry: StoredCacheEntry): Promise<void> {
		if (!this.entries.has(entry.key)) this.writeOrder.push(entry.key);
		this.entries.set(entry.key, { ...entry });
	}

	async deleteByProvider(providerId: string): Promise<void> {
		for (const [key, entry] of this.entries) {
			if (entry.providerId === providerId) this.entries.delete(key);
		}
	}

	async clear(): Promise<void> {
		this.entries.clear();
		this.writeOrder.length = 0;
	}

	/** Makes the entry claim it came off the wire at `storedAt`. */
	rewind(key: string, storedAt: number): void {
		const entry = this.entries.get(key);
		if (!entry) throw new Error(`rewind: nothing cached under ${key}`);
		this.entries.set(key, { ...entry, storedAt });
	}

	forget(key: string): void {
		this.entries.delete(key);
	}
}

beforeEach(() => {
	fetchCallCount = 0;
	searchUrlsSeen = [];
	localStorage.clear();
	clearInFlightForTests();
	resetPermanentFailuresForTests();
	clearProviderQuotaStateForTests();
});

describe('searchStays', () => {
	it('searches by real coordinates (no reverse-geocoding needed) and drills into the cheapest candidate on a cold cache', async () => {
		const provider = createBookingStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// 1 search + 1 drill-down (this adapter's default cap — see booking.ts's header
		// for why it is a fifth of agoda.ts's).
		expect(result.requestsUsed).toBe(2);
		expect(result.source.providerId).toBe('booking');

		// The raw coordinate, not a place name, is what actually reached Booking.
		expect(searchUrlsSeen[0]).toContain(`latitude=${query.near.latitude}`);
		expect(searchUrlsSeen[0]).toContain(`longitude=${query.near.longitude}`);

		expect(result.data).toEqual([
			{
				property: expect.objectContaining({ name: 'Ibis Vienna Airport' }),
				roomKind: 'private',
				pricePerNight: { minorUnits: 7527, currency: 'EUR' }
			}
		]);
	});

	it('clamps a radius below the confirmed minimum instead of failing the search', async () => {
		const provider = createBookingStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays({ ...query, radiusKm: 3 }, { signal: new AbortController().signal, keys: apiKeys });

		expect(result.ok).toBe(true);
		// Live testing found radius=5 rejected as invalid but radius=10 accepted — see
		// booking-client.ts MIN_SEARCH_RADIUS_KM.
		expect(searchUrlsSeen[0]).toContain('radius=10');
	});

	it('serves a second identical search entirely from cache', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		const provider = createBookingStayProvider({ store, fetchImpl });

		const first = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });
		const callsAfterFirst = fetchCallCount;
		const second = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.requestsUsed).toBe(0);
		expect(fetchCallCount).toBe(callsAfterFirst);
	});

	it('spends only the search request when ctx.maxRequests leaves no room to drill down', async () => {
		const provider = createBookingStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys, maxRequests: 1 });

		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 1 });
	});

	it('returns missing-key without spending any request when no key is configured', async () => {
		const provider = createBookingStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays(query, { signal: new AbortController().signal });

		expect(result).toMatchObject({ ok: false, error: { code: 'missing-key' }, requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
	});

	it('maps a 403 from Booking to not-subscribed', async () => {
		const fetchImpl = fixtureFetch({
			'https://booking-com15.p.rapidapi.com/api/v1/hotels/searchHotelsByCoordinates': () =>
				new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
		});
		const provider = createBookingStayProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result).toMatchObject({ ok: false, error: { code: 'not-subscribed', status: 403 }, requestsUsed: 1 });
	});

	it('maps a 429 from Booking to quota-exceeded', async () => {
		const fetchImpl = fixtureFetch({
			'https://booking-com15.p.rapidapi.com/api/v1/hotels/searchHotelsByCoordinates': () =>
				new Response('{}', { status: 429, headers: { 'retry-after': '60' } })
		});
		const provider = createBookingStayProvider({ store: new MemoryCacheStore(), fetchImpl, sleep: instantSleep });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		// `callProviderWithBudget` (../budget) retries a 429 with backoff before giving up —
		// every attempt here gets the same response, so it spends all 3 default attempts
		// (requestsUsed: 3) before reporting the last one's Retry-After hint.
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'quota-exceeded', status: 429, retryAfterSeconds: 60 },
			requestsUsed: 3
		});
	});

	it('maps Booking’s own soft-error 200 (bad parameter) to malformed-response', async () => {
		// Real shape confirmed live 2026-09-04: a bad `languagecode` came back HTTP 200
		// with `{"status":false,"message":[...]}, not a 4xx.
		const fetchImpl = fixtureFetch({
			'https://booking-com15.p.rapidapi.com/api/v1/hotels/searchHotelsByCoordinates': () =>
				new Response(JSON.stringify({ status: false, message: [{ radius: 'Invalid value' }] }), { status: 200 })
		});
		const provider = createBookingStayProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result).toMatchObject({ ok: false, error: { code: 'malformed-response' }, requestsUsed: 1 });
	});

	it('respects an already-cancelled signal without making any request', async () => {
		const controller = new AbortController();
		controller.abort();
		const provider = createBookingStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays(query, { signal: controller.signal, keys: apiKeys });

		expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' }, requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
	});
});

describe('estimateSearchStaysCost', () => {
	it('reports the worst case: one search plus its (deliberately small) drill-down cap', () => {
		const provider = createBookingStayProvider();
		expect(provider.estimateSearchStaysCost(query)).toBe(2);
	});
});

/**
 * Issue #151. ResultCard renders `source.fetchedAt` as "via Booking · fetched 40 minutes
 * ago", so a cache hit that stamps `new Date()` tells the traveller an hour-old price was
 * just checked. A search here is assembled from two independently cached pieces (the
 * candidate list and the room list drilled out of it), which is why the third test exists:
 * the pair can only honestly claim the age of its older half.
 */
describe('source.fetchedAt', () => {
	async function warmCache(store: RewindableCacheStore) {
		const provider = createBookingStayProvider({ store, fetchImpl: fixtureFetch() });
		const warm = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });
		expect(warm.ok).toBe(true);
		const [searchKey, ...roomListKeys] = store.writeOrder;
		expect(roomListKeys).toHaveLength(1);
		return { provider, searchKey, roomListKeys };
	}

	it('reports when the cached data came off the wire, not when it was read back out', async () => {
		const store = new RewindableCacheStore();
		const { provider, searchKey, roomListKeys } = await warmCache(store);
		const fetchedAt = Date.now() - 40 * MINUTE_MS;
		for (const key of [searchKey, ...roomListKeys]) store.rewind(key, fetchedAt);

		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result.requestsUsed).toBe(0);
		expect(result.source.fetchedAt).toBe(new Date(fetchedAt).toISOString());
	});

	it('dates a room list fetched now by the cached candidate list it was chosen from', async () => {
		const store = new RewindableCacheStore();
		const { provider, searchKey, roomListKeys } = await warmCache(store);
		const searchFetchedAt = Date.now() - 55 * MINUTE_MS;
		store.rewind(searchKey, searchFetchedAt);
		for (const key of roomListKeys) store.forget(key);

		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result.requestsUsed).toBe(1);
		expect(result.source.fetchedAt).toBe(new Date(searchFetchedAt).toISOString());
	});

	it('dates a fresh candidate list by its older cached room list', async () => {
		const store = new RewindableCacheStore();
		const { provider, searchKey, roomListKeys } = await warmCache(store);
		const roomListFetchedAt = Date.now() - 50 * MINUTE_MS;
		store.rewind(searchKey, Date.now() - 2 * MINUTE_MS);
		for (const key of roomListKeys) store.rewind(key, roomListFetchedAt);

		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result.requestsUsed).toBe(0);
		expect(result.source.fetchedAt).toBe(new Date(roomListFetchedAt).toISOString());
	});
});
