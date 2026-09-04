import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import type { Coordinates } from '../../domain';
import type { ProviderContext } from '../types';
import {
	createOsrmTransferProvider,
	findTransfersToMany,
	getTaxiFareEstimate,
	osrmTransferProvider
} from './osrm';

// Barcelona airport (T1) and a real, OSM-listed hotel a few km away (INNSiDE by
// Meliá, formerly TRYP Barcelona Aeropuerto) — see the real verification call run
// during development, which confirmed this pair returns a plausible walking time
// (roughly an hour on foot for ~5km, roughly six minutes driving) from the actual
// public routing.openstreetmap.de service this adapter uses.
const AIRPORT: Coordinates = { latitude: 41.2971, longitude: 2.0785 };
const HOTEL: Coordinates = { latitude: 41.3874, longitude: 2.1686 };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function routeBody(durationSeconds: number, distanceMeters: number) {
	return { code: 'Ok', routes: [{ duration: durationSeconds, distance: distanceMeters }] };
}

function tableBody(durationsRow: (number | null)[]) {
	return { code: 'Ok', durations: [durationsRow] };
}

function ctxFor(signal: AbortSignal = new AbortController().signal, maxRequests?: number): ProviderContext {
	return { signal, maxRequests };
}

describe('createOsrmTransferProvider / searchTransfers', () => {
	it('builds URLs with OSRM\'s lon,lat order, not this codebase\'s lat/lon order', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 800)));
		const provider = createOsrmTransferProvider({
			store: new MemoryCacheStore(),
			fetchImpl,
			baseUrl: 'https://example.test'
		});

		await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		const [url] = fetchImpl.mock.calls[0] as [string];
		// AIRPORT is {latitude: 41.2971, longitude: 2.0785} — the URL must read
		// "2.0785,41.2971", never "41.2971,2.0785".
		expect(url).toContain('2.0785,41.2971');
		expect(url).toContain('2.1686,41.3874');
		expect(url).not.toContain('41.2971,2.0785');
	});

	it('routes walking through routed-foot and driving through routed-car', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 800)));
		const provider = createOsrmTransferProvider({
			store: new MemoryCacheStore(),
			fetchImpl,
			baseUrl: 'https://example.test'
		});

		await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk', 'drive'] }, ctxFor());

		const urls = fetchImpl.mock.calls.map((call) => call[0] as string);
		expect(urls.some((url) => url.includes('/routed-foot/route/v1/foot/'))).toBe(true);
		expect(urls.some((url) => url.includes('/routed-car/route/v1/driving/'))).toBe(true);
	});

	it('returns walk, drive and taxi Transfers, sharing one driving fetch between drive and taxi', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(routeBody(1800, 1200))) // walking: 30 min
			.mockResolvedValueOnce(jsonResponse(routeBody(300, 2500))); // driving: 5 min
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL }, ctxFor());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(fetchImpl).toHaveBeenCalledTimes(2); // one walking route, one driving route
		expect(result.requestsUsed).toBe(2);

		const byMode = Object.fromEntries(result.data.map((t) => [t.mode, t]));
		expect(byMode.walk.duration).toBe(30);
		expect(byMode.drive.duration).toBe(5);
		expect(byMode.taxi.duration).toBe(5);
		// The taxi Transfer must never carry a price: only a real Money belongs there,
		// and OSRM never has one.
		expect(byMode.taxi.price).toBeUndefined();
	});

	it('never issues a network request for a pair already cached and still fresh', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 800)));
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		const first = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());
		const second = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(first.ok && first.requestsUsed).toBe(1);
		expect(second.ok && second.requestsUsed).toBe(0);
		expect(second.ok && second.data[0].duration).toBe(first.ok && first.data[0].duration);
	});

	it('stops within a caller-imposed request budget and returns a partial, still-ok result', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 800)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		// Budget of 1: the walking fetch spends it, so the driving fetch (needed for
		// 'drive' and 'taxi') must be skipped rather than exceeding the budget.
		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['walk', 'drive'] },
			ctxFor(new AbortController().signal, 1)
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.requestsUsed).toBe(1);
		expect(result.data.map((t) => t.mode)).toEqual(['walk']);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('resolves a typed cancelled result instead of throwing when already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = vi.fn();
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL }, ctxFor(controller.signal));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('cancelled');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('drops just the unreachable mode on NoRoute, keeping the rest as a normal partial result', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ code: 'NoRoute', message: 'no route found' }))
			.mockResolvedValueOnce(jsonResponse(routeBody(300, 2500)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk', 'drive'] }, ctxFor());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.map((t) => t.mode)).toEqual(['drive']);
	});

	it('maps a non-2xx HTTP response to a network-error', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('network-error');
	});

	it('maps invalid JSON to a malformed-response error', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed-response');
	});

	/**
	 * Issue #68: OSRM's response is stable, self-hosted FOSS rather than a RapidAPI scraper
	 * listing, so there is no captured evidence of it ever sending these shapes — but the
	 * same "a schema drift becomes NaN in a Duration, not a thrown error" risk this whole
	 * sweep is about applies just the same, and a corrupted response must fail closed rather
	 * than produce a wrong duration.
	 */
	it('maps a response missing a "code" field to malformed-response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ routes: [{ duration: 600, distance: 800 }] }));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed-response');
	});

	it('maps a route response with a non-numeric duration to malformed-response, not NaN', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ code: 'Ok', routes: [{ duration: 'soon', distance: 800 }] }));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed-response');
	});

	it('maps a route response with a missing routes array to malformed-response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 'Ok' }));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed-response');
	});

	it('rejects coordinates outside a valid lat/lon range rather than querying OSRM with them', async () => {
		const fetchImpl = vi.fn();
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers(
			{ from: { latitude: 200, longitude: 2 }, to: HOTEL, modes: ['walk'] },
			ctxFor()
		);

		expect(result.ok).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('returns an empty, ok result for modes this adapter does not serve', async () => {
		const fetchImpl = vi.fn();
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['transit'] }, ctxFor());

		expect(result).toEqual({
			ok: true,
			data: [],
			source: expect.objectContaining({ providerId: 'osrm' }),
			requestsUsed: 0
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('declares itself keyless, matching the keyless baseline providers', () => {
		expect(osrmTransferProvider.needsKey).toBe(false);
		expect(osrmTransferProvider.keyFields).toEqual([]);
		expect(osrmTransferProvider.kind).toBe('transfer');
		expect(osrmTransferProvider.id).toBe('osrm');
	});
});

describe('healthCheck', () => {
	it('reports reachable on a successful /nearest lookup', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 'Ok', waypoints: [{}] }));
		const provider = createOsrmTransferProvider({ fetchImpl });

		const result = await provider.healthCheck(ctxFor());

		expect(result.ok).toBe(true);
		expect(result.requestsUsed).toBe(1);
		const [url] = fetchImpl.mock.calls[0] as [string];
		expect(url).toContain('/routed-car/nearest/v1/driving/');
	});

	it('surfaces a network-error when the server is unreachable', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError('failed to fetch'));
		const provider = createOsrmTransferProvider({ fetchImpl });

		const result = await provider.healthCheck(ctxFor());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('network-error');
	});
});

describe('findTransfersToMany', () => {
	const destinations: Coordinates[] = [
		{ latitude: 41.39, longitude: 2.16 },
		{ latitude: 41.4, longitude: 2.17 },
		{ latitude: 41.41, longitude: 2.18 }
	];

	it('answers every destination with exactly one table request, not one per destination', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(tableBody([600, 900, 1200])));
		const store = new MemoryCacheStore();

		const result = await findTransfersToMany('walk', AIRPORT, destinations, ctxFor(), { store, fetchImpl });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result.requestsUsed).toBe(1);
		expect(result.data.map((t) => t?.duration)).toEqual([10, 15, 20]);

		const [url] = fetchImpl.mock.calls[0] as [string];
		expect(url).toContain('/routed-foot/table/v1/foot/');
		expect(url).toContain('sources=0');
	});

	it('marks a destination OSRM cannot reach as undefined rather than failing the whole batch', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(tableBody([600, null, 1200])));

		const result = await findTransfersToMany('walk', AIRPORT, destinations, ctxFor(), {
			store: new MemoryCacheStore(),
			fetchImpl
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0]?.duration).toBe(10);
		expect(result.data[1]).toBeUndefined();
		expect(result.data[2]?.duration).toBe(20);
	});

	it('maps a table response with a non-numeric duration entry to malformed-response, not NaN (issue #68)', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 'Ok', durations: [[600, 'soon', 1200]] }));

		const result = await findTransfersToMany('walk', AIRPORT, destinations, ctxFor(), {
			store: new MemoryCacheStore(),
			fetchImpl
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed-response');
	});

	it('only asks the table service for destinations not already cached', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tableBody([600, 900, 1200])))
			.mockResolvedValueOnce(jsonResponse(tableBody([1500])));

		await findTransfersToMany('walk', AIRPORT, destinations, ctxFor(), { store, fetchImpl });

		// A 4th destination, none of which were part of the first batch except by
		// coincidence of caching — only the genuinely new one should reach the network.
		const secondBatch = [destinations[0], destinations[1], { latitude: 41.5, longitude: 2.3 }];
		const result = await findTransfersToMany('walk', AIRPORT, secondBatch, ctxFor(), { store, fetchImpl });

		expect(result.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const [, secondUrl] = fetchImpl.mock.calls.map((call) => call[0] as string);
		// Only one destination coordinate (plus the origin) should appear in the second
		// call's coordinate list.
		expect(secondUrl).toContain('2.3,41.5');
	});

	it('returns an empty ok result with no request for an empty destination list', async () => {
		const fetchImpl = vi.fn();
		const result = await findTransfersToMany('walk', AIRPORT, [], ctxFor(), { fetchImpl });
		expect(result).toEqual({ ok: true, data: [], source: expect.any(Object), requestsUsed: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('getTaxiFareEstimate', () => {
	it('returns a real duration plus a labelled, ranged fare estimate', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 5000))); // 5km, 10 min
		const result = await getTaxiFareEstimate(AIRPORT, HOTEL, 'ES', ctxFor(), {
			store: new MemoryCacheStore(),
			fetchImpl
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.duration).toBe(10);
		expect(result.data.distanceMeters).toBe(5000);
		expect(result.data.fareEstimate.kind).toBe('estimate');
		expect(result.data.fareEstimate.countryCode).toBe('ES');
		expect(result.data.fareEstimate.lowMinorUnits).toBeLessThan(result.data.fareEstimate.highMinorUnits);
	});

	it('reuses a driving route already cached by searchTransfers instead of fetching again', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 5000)));
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['drive'] }, ctxFor());
		const result = await getTaxiFareEstimate(AIRPORT, HOTEL, 'ES', ctxFor(), { store, fetchImpl });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result.ok && result.requestsUsed).toBe(0);
	});

	it('re-fetches with distance when the only cached entry for this pair came from a duration-only batch lookup', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tableBody([600]))) // batch: duration only
			.mockResolvedValueOnce(jsonResponse(routeBody(600, 5000))); // full route: has distance

		await findTransfersToMany('drive', AIRPORT, [HOTEL], ctxFor(), { store, fetchImpl });
		const result = await getTaxiFareEstimate(AIRPORT, HOTEL, 'ES', ctxFor(), { store, fetchImpl });

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result.ok).toBe(true);
		expect(result.ok && result.data.distanceMeters).toBe(5000);
	});
});
