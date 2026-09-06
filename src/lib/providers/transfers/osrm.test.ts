import { describe, expect, it, vi } from 'vitest';
import { defineCacheKey, MemoryCacheStore } from '../../cache';
import type { Coordinates } from '../../domain';
import type { ProviderContext } from '../types';
import {
	createOsrmTransferProvider,
	findTransfersToMany,
	OSRM_PROVIDER_ID,
	osrmTransferProvider
} from './osrm';
import type { Transfer } from '../../domain';

// Barcelona airport (T1) and a point in El Prat about 2.1 km north of it: an ordinary
// airport-hotel hop, and the shape of leg this adapter exists to answer.
//
// Issue #204 moved this point. It used to sit at 41.3874, 2.1686, which is central
// Barcelona, 12.55 km from T1 — a walk of roughly two hours forty at the ~4.5 km/h this
// adapter's foot profile was measured at. The comment above it still described "a real,
// OSM-listed hotel a few km away... roughly an hour on foot for ~5km", so the coordinates
// and their own documentation had drifted apart, and every walking assertion below was
// really asserting a walk `search/resources.ts` throws away on arrival. 2.1 km is inside
// `MAX_PLAUSIBLE_WALK_MINUTES` with room to spare, so these tests now exercise a walk the
// app would actually offer somebody.
const AIRPORT: Coordinates = { latitude: 41.2971, longitude: 2.0785 };
const HOTEL: Coordinates = { latitude: 41.3128, longitude: 2.0925 };

/** Central Barcelona, 12.55 km from T1. Far enough that no walking route could come back
 * inside the cap, which is what `walkIsWorthRouting` refuses to ask about. */
const DISTANT_HOTEL: Coordinates = { latitude: 41.3874, longitude: 2.1686 };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function routeBody(durationSeconds: number, distanceMeters: number, geometry?: unknown) {
	return { code: 'Ok', routes: [{ duration: durationSeconds, distance: distanceMeters, geometry }] };
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
		expect(url).toContain('2.0925,41.3128');
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

	it('asks for the full GeoJSON overview and turns it into the Transfer\'s path (issues #118, #408)', async () => {
		const geometry = { type: 'LineString', coordinates: [[2.0785, 41.2971], [2.12, 41.34], [2.1686, 41.3874]] };
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 800, geometry)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		const [url] = fetchImpl.mock.calls[0] as [string];
		// `full`, not `simplified`. #408: a ground preview fits one leg to its own window,
		// so `simplified`'s ten points across a 14.5 km airport run draw a zigzag where the
		// road has bends. What is kept is thinned back down before it reaches the cache;
		// the test below this one is where that half is pinned.
		expect(url).toContain('overview=full');
		expect(url).toContain('geometries=geojson');
		// Still one request — the geometry rides along on the same route fetch this
		// adapter already made for the duration, not a second one.
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// GeoJSON's [lon, lat] order flipped back to this codebase's {latitude, longitude}.
		expect(result.data[0].path).toEqual([
			{ latitude: 41.2971, longitude: 2.0785 },
			{ latitude: 41.34, longitude: 2.12 },
			{ latitude: 41.3874, longitude: 2.1686 }
		]);
	});

	it('thins the road before caching it, so full geometry does not eat the shared budget (#408)', async () => {
		// `overview=full` on a real 14.5 km airport transfer returns 446 points and caches
		// as 19 kB. `cache/constants.ts` gives every provider 5 MB between them, and 120
		// such routes would be 92% of it — an eviction that reads to a traveller as the map
		// silently reverting to straight lines. What is kept is the detail something can
		// actually draw. Six hundred points of gently wobbling road here, none of the
		// wobble bigger than the leg over 1,200.
		const coordinates = Array.from({ length: 600 }, (_, i) => [
			2.0785 + (0.09 * i) / 599 + Math.cos(i / 5) * 0.00002,
			41.2971 + (0.08 * i) / 599 + Math.sin(i / 7) * 0.00002
		]);
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(routeBody(600, 800, { type: 'LineString', coordinates })));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const path = result.data[0].path;
		expect(path).toBeDefined();
		expect(path!.length).toBeLessThan(50);
		// Both ends survive thinning exactly as OSRM sent them. That matters beyond tidiness:
		// `segments.ts` splices the itinerary's own endpoints back over them, and a path
		// whose ends had wandered would leave a kink where the splice lands.
		expect(path![0].longitude).toBeCloseTo(coordinates[0][0], 5);
		expect(path![path!.length - 1].longitude).toBeCloseTo(coordinates[599][0], 5);
	});

	it('leaves Transfer.path undefined, without throwing, when OSRM omits or malforms the geometry', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 800))); // no geometry field
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0].duration).toBe(10); // the duration this call actually needed still comes through
		expect(result.data[0].path).toBeUndefined();
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

	it('does not serve a still-fresh entry written under the pre-geometry cache key shape (30-day stale-geometry window)', async () => {
		const store = new MemoryCacheStore();
		// The exact key `routeCacheKey` produced before it hashed a `geometry` shape
		// discriminator alongside `service`/`profile`/`origin`/`destination` — this is
		// deliberately NOT built by calling this adapter's own current code, since the
		// whole point is to reproduce what a real browser already has on disk from
		// before this fix shipped.
		const oldShapeKey = defineCacheKey(
			OSRM_PROVIDER_ID,
			{
				service: 'route',
				profile: 'walking',
				origin: { lat: AIRPORT.latitude, lon: AIRPORT.longitude },
				destination: { lat: HOTEL.latitude, lon: HOTEL.longitude }
			},
			30 * 24 * 60 * 60 * 1000 // ROUTE_CACHE_TTL_MS in osrm.ts
		);
		const now = Date.now();
		await store.set({
			key: oldShapeKey.raw,
			providerId: OSRM_PROVIDER_ID,
			// The old cached value: a real, still-correct duration/distance, but no
			// `path` — exactly what every entry written by the `overview=false` request
			// looked like.
			value: { durationSeconds: 600, distanceMeters: 800 },
			storedAt: now, // written "just now" — nowhere near the 30-day TTL boundary
			ttlMs: 30 * 24 * 60 * 60 * 1000,
			lastAccessedAt: now,
			sizeBytes: 64
		});

		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(routeBody(600, 800, { type: 'LineString', coordinates: [[2.0785, 41.2971], [2.1686, 41.3874]] })));
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The old-shape entry must count as a miss: a real request went out (never
		// served straight back as a "fresh" hit missing the whole point of this fix)...
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result.requestsUsed).toBe(1);
		// ...and the walking Transfer this adapter now returns actually carries the
		// geometry the old entry never could.
		expect(result.data[0].path).toEqual([
			{ latitude: 41.2971, longitude: 2.0785 },
			{ latitude: 41.3874, longitude: 2.1686 }
		]);
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

	// Issue #204 -------------------------------------------------------------

	it('never asks for a walking route nobody could walk', async () => {
		// Production, on the owner's own URL: a bed 48 km from Gatwick made this adapter ask
		// the shared FOSSGIS instance for a 48 km foot route four times, and every one came
		// back `net::ERR_CONNECTION_RESET`. `search/resources.ts` would have discarded that
		// walk on arrival anyway (`MAX_PLAUSIBLE_WALK_MINUTES`), so the request could only
		// ever have been waste. Great-circle distance is a lower bound on any real path, so
		// this can be decided before spending anything.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 800)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: DISTANT_HOTEL, modes: ['walk'] },
			ctxFor()
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual([]);
		expect(result.requestsUsed).toBe(0);
	});

	it('still routes the drive when the walk is too far to be worth asking about', async () => {
		// The distance gate must not cost the traveller the answer that does exist. A bed
		// across the city is reachable, just not on foot.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(1500, 12_000)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: DISTANT_HOTEL, modes: ['walk', 'drive', 'taxi'] },
			ctxFor()
		);

		expect(fetchImpl).toHaveBeenCalledTimes(1); // the driving route, and only that
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.map((t) => t.mode)).toEqual(['drive', 'taxi']);
	});

	it('keeps a working drive when the walk request itself fails', async () => {
		// The production defect underneath the one above, and the one that survives any
		// radius: `getCachedRoute` rethrows a network failure, the walking lookup runs
		// first, and one try/catch wrapped both profiles. So a reset on the foot route
		// skipped the driving route entirely and failed the whole call, `resources.ts` found
		// no transfer, and a bed Hostelworld had priced at EUR 13.00 was dropped and
		// reported as "No bed priced for this stopover".
		const fetchImpl = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockResolvedValueOnce(jsonResponse(routeBody(300, 2500)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['walk', 'drive'] },
			ctxFor()
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.map((t) => t.mode)).toEqual(['drive']);
	});

	it('still fails, with the provider\'s own error, when every mode fails', async () => {
		// An empty `ok` result would read as "asked, and there is nothing here", which is a
		// different answer and the one issues #130/#135 exist to stop us inventing.
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['walk', 'drive'] },
			ctxFor()
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('network-error');
		expect(result.error.message).toContain('Failed to fetch');
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

/**
 * Issue #249. The rate-card range used to be a separate export a caller reached past the
 * `TransferProvider` interface for; it is now a field on the taxi `Transfer` this adapter
 * already builds from the same driving route. The assertions are the same measurements,
 * asked of the answer callers actually receive.
 */
describe('a taxi carries the rate card\'s estimate for its own ride', () => {
	/** Narrows to the taxi among a mode-mixed answer, so a test about the fare fails loudly
	 * rather than silently reading `undefined` off a walk. */
	function taxiIn(transfers: readonly Transfer[]): Transfer {
		const taxi = transfers.find((transfer) => transfer.mode === 'taxi');
		if (!taxi) throw new Error('expected a taxi among the transfers');
		return taxi;
	}

	it('attaches a labelled, ranged estimate when the caller names a country', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 5000))); // 5km, 10 min
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['taxi'], countryCode: 'ES' },
			ctxFor()
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const taxi = taxiIn(result.data);
		expect(taxi.duration).toBe(10);
		// Never a quote. The whole point of the separate field.
		expect(taxi.price).toBeUndefined();
		expect(taxi.fareEstimate?.countryCode).toBe('ES');
		if (taxi.fareEstimate?.kind !== 'estimate') throw new Error('expected a priced range');
		expect(taxi.fareEstimate.lowMinorUnits).toBeLessThan(taxi.fareEstimate.highMinorUnits);
	});

	it('leaves the estimate off entirely when no country was given to rate it against', async () => {
		// A Barcelona flag-down against a Zurich one is a factor of three, so the wrong card
		// is worse than no card. The ride itself still comes back.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 5000)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['taxi'] }, ctxFor());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(taxiIn(result.data).fareEstimate).toBeUndefined();
	});

	it("carries the rate table's refusal through for a ride longer than the cards cover", async () => {
		// Issue #246: the duration is a real measurement and still comes back; only the fare
		// is withheld. 95 km is the Gatwick-to-London-Backpackers run the issue reported
		// priced at £268.75-£430.90.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(4560, 94_900)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['taxi'], countryCode: 'GB' },
			ctxFor()
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const taxi = taxiIn(result.data);
		expect(taxi.duration).toBe(76);
		expect(taxi.fareEstimate?.kind).toBe('out-of-range');
		if (taxi.fareEstimate?.kind !== 'out-of-range') return;
		expect(Math.round(taxi.fareEstimate.distanceKm)).toBe(95);
	});

	it('never estimates a drive, which is fuel and parking rather than a meter', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 5000)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['drive', 'taxi'], countryCode: 'ES' },
			ctxFor()
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const drive = result.data.find((transfer) => transfer.mode === 'drive');
		expect(drive?.fareEstimate).toBeUndefined();
		expect(taxiIn(result.data).fareEstimate?.kind).toBe('estimate');
	});

	it('re-fetches with a distance when the cached entry for this pair came from a duration-only batch lookup', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tableBody([600]))) // batch: duration only
			.mockResolvedValueOnce(jsonResponse(routeBody(600, 5000))); // full route: has distance
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		await findTransfersToMany('drive', AIRPORT, [HOTEL], ctxFor(), { store, fetchImpl });
		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['taxi'], countryCode: 'ES' },
			ctxFor()
		);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(taxiIn(result.data).fareEstimate?.kind).toBe('estimate');
	});

	/**
	 * Issue #405 gave `findTransfersToMany` its first production caller, and this is the
	 * damage that would have followed. The batch writes duration-only entries under the same
	 * key `searchTransfers` reads full routes from, so for thirty days afterwards every leg
	 * this app drew between those two points would have come back with no geometry: issue
	 * #131's straight-line map, arriving from a completely different direction. Nothing in a
	 * fresh browser can show it, because the list has to write first and the map second.
	 */
	it('re-fetches a walk whose only cached entry came from the batch, so the map still gets a path', async () => {
		const store = new MemoryCacheStore();
		const geometry = {
			type: 'LineString',
			coordinates: [
				[2.0785, 41.2971],
				[2.0925, 41.3128]
			]
		};
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tableBody([600]))) // batch: duration only
			.mockResolvedValueOnce(jsonResponse(routeBody(600, 2100, geometry)));
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		await findTransfersToMany('walk', AIRPORT, [HOTEL], ctxFor(), { store, fetchImpl });
		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0].path).toHaveLength(2);
	});

	it('re-fetches a drive from a batch entry even with no country to rate a fare against', async () => {
		// The old rule only upgraded the entry when a taxi fare needed the distance, so this
		// query — a drive, no `countryCode` — read the thin entry as a complete answer.
		const store = new MemoryCacheStore();
		const geometry = {
			type: 'LineString',
			coordinates: [
				[2.0785, 41.2971],
				[2.0925, 41.3128]
			]
		};
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tableBody([600])))
			.mockResolvedValueOnce(jsonResponse(routeBody(600, 5000, geometry)));
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		await findTransfersToMany('drive', AIRPORT, [HOTEL], ctxFor(), { store, fetchImpl });
		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['drive'] }, ctxFor());

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0].path).toHaveLength(2);
	});

	it('still answers the batch itself from a full entry the search already wrote, at no cost', async () => {
		// The saving that makes one shared key worth keeping: a pair the search has already
		// routed in full needs no table slot, so the stay list asks about fewer destinations
		// rather than re-asking about all of them under a key of its own.
		const store = new MemoryCacheStore();
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 5000)));
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['drive'] }, ctxFor());
		const batch = await findTransfersToMany('drive', AIRPORT, [HOTEL], ctxFor(), { store, fetchImpl });

		expect(batch.requestsUsed).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(batch.ok).toBe(true);
		if (!batch.ok) return;
		expect(batch.data[0]?.duration).toBe(10);
	});

	it('spends no extra request rating a route the same call already fetched', async () => {
		// The estimate is arithmetic over a distance OSRM returns anyway, so asking for one
		// must never cost the shared demo server a second lookup (issue #213).
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 5000)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['drive', 'taxi'], countryCode: 'ES' },
			ctxFor()
		);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result.requestsUsed).toBe(1);
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

	/** The keys `seed` wrote under, discovered rather than hardcoded: `routeCacheKey`
	 * hashes its query and that hash is not this test's business — a hand-built copy would
	 * quietly stop matching the day the key shape changes, and every assertion below would
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

	const TWO_HOURS_MS = 2 * 60 * 60_000;

	it('reports when the route was really fetched, not when the cache was read', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 800)));
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		const keys = await keysWrittenBy(store, () =>
			provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor())
		);
		const [storedAt] = await ageStoredEntriesBy(store, TWO_HOURS_MS, keys);

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		expect(fetchImpl).toHaveBeenCalledTimes(1); // the second call really was served from cache
		expect(result.source.fetchedAt).toBe(new Date(storedAt).toISOString());
	});

	it('dates a half-cached answer by its oldest part, not by the leg it just fetched', async () => {
		const store = new MemoryCacheStore();
		// A fresh Response per call: a body can only be read once, and this test really
		// does fetch twice (the walking seed, then the driving leg).
		const fetchImpl = vi.fn(async () => jsonResponse(routeBody(600, 800)));
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		const walkKeys = await keysWrittenBy(store, () =>
			provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor())
		);
		const [walkStoredAt] = await ageStoredEntriesBy(store, TWO_HOURS_MS, walkKeys);

		// Walking comes back from the two-hour-old entry; driving is fetched now.
		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk', 'drive'] }, ctxFor());

		expect(result.ok && result.data).toHaveLength(2);
		expect(result.source.fetchedAt).toBe(new Date(walkStoredAt).toISOString());
	});

	it('dates a batch by its oldest cached leg, not by the table request it just made', async () => {
		const store = new MemoryCacheStore();
		const nearby: Coordinates = { latitude: 41.39, longitude: 2.16 };
		const further: Coordinates = { latitude: 41.41, longitude: 2.18 };
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tableBody([600])))
			.mockResolvedValueOnce(jsonResponse(tableBody([900])));

		const keys = await keysWrittenBy(store, () =>
			findTransfersToMany('walk', AIRPORT, [nearby], ctxFor(), { store, fetchImpl })
		);
		const [nearbyStoredAt] = await ageStoredEntriesBy(store, TWO_HOURS_MS, keys);

		const result = await findTransfersToMany('walk', AIRPORT, [nearby, further], ctxFor(), { store, fetchImpl });

		expect(result.requestsUsed).toBe(1); // only `further` reached the network
		expect(result.source.fetchedAt).toBe(new Date(nearbyStoredAt).toISOString());
	});

	it('dates a taxi estimate by the driving route it reused', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 5000)));
		const provider = createOsrmTransferProvider({ store, fetchImpl });

		const keys = await keysWrittenBy(store, () =>
			provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['taxi'], countryCode: 'ES' }, ctxFor())
		);
		const [storedAt] = await ageStoredEntriesBy(store, TWO_HOURS_MS, keys);

		const result = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['taxi'], countryCode: 'ES' },
			ctxFor()
		);

		expect(result.requestsUsed).toBe(0);
		expect(result.source.fetchedAt).toBe(new Date(storedAt).toISOString());
	});
});

/**
 * Issue #213. Both of these are about what one search costs the shared, volunteer-run
 * `routing.openstreetmap.de` instance, which had already refused this project's traffic
 * for a stretch before the issue was opened.
 *
 * Measured against a build of 57fa876 with `tools/probe-osrm-requests.mjs`: one cold search
 * made twelve requests, every one of them a distinct coordinate pair, and OSRM refused
 * five. So the issue's "every pair is requested twice" is not what the app does — those
 * twelve URLs are all different. What it did do is send them all at once.
 */
describe('what one search costs the shared demo server (issue #213)', () => {
	/** Six destinations spread around the airport: far enough apart to be six distinct cache
	 * keys, close enough that each is an ordinary airport-to-hotel hop. */
	const SIX_DESTINATIONS: Coordinates[] = [
		{ latitude: 41.3128, longitude: 2.0925 },
		{ latitude: 41.3129, longitude: 2.0926 },
		{ latitude: 41.313, longitude: 2.0927 },
		{ latitude: 41.3131, longitude: 2.0928 },
		{ latitude: 41.3132, longitude: 2.0929 },
		{ latitude: 41.3133, longitude: 2.093 }
	];

	it('spaces concurrent lookups apart instead of firing them all on one tick', async () => {
		const sentAt: number[] = [];
		const fetchImpl = vi.fn(async () => {
			sentAt.push(Date.now());
			return jsonResponse(routeBody(600, 5000));
		});
		const provider = createOsrmTransferProvider({
			store: new MemoryCacheStore(),
			fetchImpl,
			// A real 1100 ms gap would make this test take seven seconds. What is under test
			// is that the gap holds between EVERY pair of concurrent callers, not its size.
			minGapBetweenRequestsMs: 40
		});

		await Promise.all(
			SIX_DESTINATIONS.map((to) =>
				provider.searchTransfers({ from: AIRPORT, to, modes: ['drive'] }, ctxFor())
			)
		);

		expect(sentAt).toHaveLength(6);
		const gaps = sentAt.slice(1).map((at, index) => at - sentAt[index]);
		// 30 rather than 40: a timer fires no earlier than its delay, but the timestamps are
		// taken inside the fetch and clock granularity shows over gaps this short.
		expect(
			Math.min(...gaps),
			`every gap should be at least the requested spacing, saw ${gaps.join('ms, ')}ms`
		).toBeGreaterThanOrEqual(30);
	});

	it('sends one request when two callers in the same search ask for the same route at once', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 5000)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });
		const ctx = ctxFor();

		const [first, second] = await Promise.all([
			provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['drive'] }, ctx),
			provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['drive'] }, ctx)
		]);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.data[0]?.duration).toBe(10);
		expect(second.data[0]?.duration).toBe(10);
		// The caller that shared somebody else's request did not make one, and says so: this
		// number is what `search/resources.ts` reports as the provider's cost on screen.
		expect(first.requestsUsed + second.requestsUsed).toBe(1);
	});

	it("never hands one search's in-flight request to a different search", async () => {
		let resolveFirst: ((value: Response) => void) | undefined;
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
			.mockResolvedValue(jsonResponse(routeBody(900, 7000)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const abandoned = new AbortController();
		const pending = provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['drive'] },
			ctxFor(abandoned.signal)
		);
		// Let the first lookup reach `fetchImpl` before the second search starts, so the
		// second would find the first's promise if the two were pooled together.
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

		const fresh = await provider.searchTransfers(
			{ from: AIRPORT, to: HOTEL, modes: ['drive'] },
			ctxFor()
		);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fresh.ok).toBe(true);
		if (!fresh.ok) return;
		expect(fresh.data[0]?.duration).toBe(15);

		resolveFirst?.(jsonResponse(routeBody(600, 5000)));
		await pending;
	});
});
