import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import type { ProviderContext } from '../types';
import { lookupAirportTimeZone, lookupTimeZoneForCoordinates, searchLocations } from './transitous';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function ctx(signal: AbortSignal = new AbortController().signal): ProviderContext {
	return { signal };
}

const AMBIGUOUS_BARCELONA_RESPONSE = [
	{ type: 'PLACE', name: 'Barcelona', lat: 41.3825802, lon: 2.177073, country: 'ES', tz: 'Europe/Madrid' },
	{ type: 'PLACE', name: 'Barcelona', lat: 10.1325951, lon: -64.6819583, country: 'VE', tz: 'America/Caracas' },
	{ type: 'PLACE', name: 'Barcelona', lat: 12.8682088, lon: 124.1418908, country: 'PH', tz: 'Asia/Manila' }
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe('searchLocations', () => {
	it('typing a place name yields real coordinates', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ type: 'STOP', name: 'Sagrada Família', lat: 41.403984, lon: 2.175106, country: 'ES', tz: 'Europe/Madrid' }]));

		const result = await searchLocations('Sagrada Familia Barcelona', ctx(), {
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(1);
		expect(result.data[0].coordinates).toEqual({ latitude: 41.403984, longitude: 2.175106 });
	});

	it('an ambiguous query resolves to multiple candidates, not one silent guess', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(AMBIGUOUS_BARCELONA_RESPONSE));

		const result = await searchLocations('Barcelona', ctx(), {
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.length).toBeGreaterThan(1);
		expect(result.data.map((c) => c.countryCode)).toEqual(expect.arrayContaining(['ES', 'VE', 'PH']));
	});

	it('caches an identical query and reports the second call as free', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(AMBIGUOUS_BARCELONA_RESPONSE));
		const store = new MemoryCacheStore();

		const first = await searchLocations('Barcelona', ctx(), { fetchImpl, resolveStore: async () => store });
		const second = await searchLocations('Barcelona', ctx(), { fetchImpl, resolveStore: async () => store });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(first.requestsUsed).toBe(1);
		expect(second.requestsUsed).toBe(0);
		expect(second.ok && first.ok && second.data).toEqual(first.ok ? first.data : undefined);
	});

	it('resolves ok:true with no candidates for a blank query, without a network call', async () => {
		const fetchImpl = vi.fn();
		const result = await searchLocations('   ', ctx(), { fetchImpl });
		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('maps a 429 to quota-exceeded and still reports the request as spent', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response('slow down', { status: 429, headers: { 'Retry-After': '20' } }));

		const result = await searchLocations('Vienna', ctx(), {
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({ code: 'quota-exceeded', status: 429, retryAfterSeconds: 20 });
	});
});

describe('lookupTimeZoneForCoordinates', () => {
	it('returns the nearest place\'s timezone', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ type: 'STOP', name: 'Aeroport de BCN', lat: 41.297, lon: 2.078, country: 'ES', tz: 'Europe/Madrid' }]));

		const result = await lookupTimeZoneForCoordinates(
			{ latitude: 41.2971, longitude: 2.07846 },
			ctx(),
			{ fetchImpl, resolveStore: async () => new MemoryCacheStore() }
		);

		expect(result).toMatchObject({ ok: true, data: 'Europe/Madrid' });
	});

	it('caches a real result and does not hit the network again for the same point', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ type: 'STOP', name: 'x', lat: 48.11, lon: 16.57, tz: 'Europe/Vienna' }]));
		const store = new MemoryCacheStore();
		const point = { latitude: 48.110298, longitude: 16.5697 };

		const first = await lookupTimeZoneForCoordinates(point, ctx(), { fetchImpl, resolveStore: async () => store });
		const second = await lookupTimeZoneForCoordinates(point, ctx(), { fetchImpl, resolveStore: async () => store });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(first).toMatchObject({ ok: true, data: 'Europe/Vienna', requestsUsed: 1 });
		expect(second).toMatchObject({ ok: true, data: 'Europe/Vienna', requestsUsed: 0 });
	});
});

describe('lookupAirportTimeZone', () => {
	it('resolves a known airport to its live timezone via the airport dataset coordinates', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ type: 'STOP', name: 'Aeroport de BCN', lat: 41.297, lon: 2.078, country: 'ES', tz: 'Europe/Madrid' }]));

		const result = await lookupAirportTimeZone('BCN', ctx(), {
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		expect(result).toMatchObject({ ok: true, data: 'Europe/Madrid' });
		const [url] = fetchImpl.mock.calls[0] as [string];
		// BCN's coordinates from data/airports.generated.json (issue #11's OurAirports
		// dataset), not a value this test invents — proves the real dataset is what feeds
		// the reverse-geocode call, not a stand-in.
		expect(url).toContain('place=41.2971%2C2.07846');
	});

	it('resolves ok:true with undefined, and makes no request, for a code outside this app\'s airport dataset', async () => {
		const fetchImpl = vi.fn();

		const result = await lookupAirportTimeZone('ZZZ', ctx(), { fetchImpl });

		expect(result).toMatchObject({ ok: true, data: undefined, requestsUsed: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('fetchedAt on a cache hit (issue #151)', () => {
	/** Ages every entry written under `keys` by `ms` and reports the new `storedAt`s, so a
	 * test can assert on the exact instant rather than on "not now". Rewriting the entry
	 * beats faking the clock: this adapter reads `Date.now()` for the source stamp, the
	 * freshness check and the cache write, and moving all three under a mock would leave
	 * the test asserting against its own fake instead of the code. Mirrors the same helper
	 * in providers/flights/ryanair.test.ts. */
	async function ageStoredEntriesBy(store: MemoryCacheStore, ms: number, keys: string[]): Promise<number[]> {
		const agedStoredAt: number[] = [];
		for (const key of keys) {
			const entry = await store.get(key);
			if (!entry) continue;
			const storedAt = entry.storedAt - ms;
			await store.set({ ...entry, storedAt });
			agedStoredAt.push(storedAt);
		}
		return agedStoredAt;
	}

	/** The keys `seed` wrote under, discovered rather than hardcoded: `defineCacheKey`
	 * hashes its query and that hash is not this test's business — a hand-built copy would
	 * quietly stop matching the day the key shape changes, and the assertions below would
	 * then be passing against a cache miss. */
	async function keysWrittenBy(store: MemoryCacheStore, seed: () => Promise<unknown>): Promise<string[]> {
		const seen: string[] = [];
		const realSet = store.set.bind(store);
		store.set = async (entry) => {
			seen.push(entry.key);
			return realSet(entry);
		};
		await seed();
		store.set = realSet;
		return seen;
	}

	// Two hours is nowhere near the 90-day TTL, so these entries are genuinely fresh —
	// the point is that "fresh" and "fetched just now" are not the same claim.
	const TWO_HOURS_MS = 2 * 60 * 60_000;

	it('searchLocations reports when the geocode was really fetched, not when the cache was read', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(AMBIGUOUS_BARCELONA_RESPONSE));
		const store = new MemoryCacheStore();
		const resolveStore = async () => store;

		const keys = await keysWrittenBy(store, () => searchLocations('Barcelona', ctx(), { fetchImpl, resolveStore }));
		const [storedAt] = await ageStoredEntriesBy(store, TWO_HOURS_MS, keys);

		const result = await searchLocations('Barcelona', ctx(), { fetchImpl, resolveStore });

		expect(fetchImpl).toHaveBeenCalledTimes(1); // the second call really was served from cache
		expect(result.source.fetchedAt).toBe(new Date(storedAt).toISOString());
	});

	it('lookupTimeZoneForCoordinates reports when the reverse lookup was really fetched', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ type: 'STOP', name: 'x', lat: 48.11, lon: 16.57, tz: 'Europe/Vienna' }]));
		const store = new MemoryCacheStore();
		const resolveStore = async () => store;
		const point = { latitude: 48.110298, longitude: 16.5697 };

		const keys = await keysWrittenBy(store, () => lookupTimeZoneForCoordinates(point, ctx(), { fetchImpl, resolveStore }));
		const [storedAt] = await ageStoredEntriesBy(store, TWO_HOURS_MS, keys);

		const result = await lookupTimeZoneForCoordinates(point, ctx(), { fetchImpl, resolveStore });

		expect(result).toMatchObject({ ok: true, data: 'Europe/Vienna', requestsUsed: 0 });
		expect(result.source.fetchedAt).toBe(new Date(storedAt).toISOString());
	});
});
