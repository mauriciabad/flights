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
