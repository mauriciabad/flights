import { describe, expect, it, vi } from 'vitest';
import { defineCacheKey, MemoryCacheStore } from '../../cache';
import type { Coordinates } from '../../domain';
import type { ProviderContext } from '../types';
import {
	createOsrmTransferProvider,
	findTransfersToMany,
	getTaxiFareEstimate,
	OSRM_PROVIDER_ID,
	osrmTransferProvider
} from './osrm';

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

	it('asks for a simplified GeoJSON overview and turns it into the Transfer\'s path (issue #118)', async () => {
		const geometry = { type: 'LineString', coordinates: [[2.0785, 41.2971], [2.12, 41.34], [2.1686, 41.3874]] };
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(600, 800, geometry)));
		const provider = createOsrmTransferProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['walk'] }, ctxFor());

		const [url] = fetchImpl.mock.calls[0] as [string];
		expect(url).toContain('overview=simplified');
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
		expect(result.data.fareEstimate.countryCode).toBe('ES');
		if (result.data.fareEstimate.kind !== 'estimate') throw new Error('expected a priced range');
		expect(result.data.fareEstimate.lowMinorUnits).toBeLessThan(result.data.fareEstimate.highMinorUnits);
	});

	it('carries the rate table\'s refusal through for a ride longer than the cards cover', async () => {
		// Issue #246: the duration and distance are real measurements and still come back;
		// only the fare is withheld. 95 km is the Gatwick-to-London-Backpackers run the issue
		// reported priced at £268.75-£430.90.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody(4560, 94_900)));
		const result = await getTaxiFareEstimate(AIRPORT, HOTEL, 'GB', ctxFor(), {
			store: new MemoryCacheStore(),
			fetchImpl
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.duration).toBe(76);
		expect(result.data.distanceMeters).toBe(94_900);
		expect(result.data.fareEstimate.kind).toBe('out-of-range');
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
			provider.searchTransfers({ from: AIRPORT, to: HOTEL, modes: ['drive'] }, ctxFor())
		);
		const [storedAt] = await ageStoredEntriesBy(store, TWO_HOURS_MS, keys);

		const result = await getTaxiFareEstimate(AIRPORT, HOTEL, 'ES', ctxFor(), { store, fetchImpl });

		expect(result.requestsUsed).toBe(0);
		expect(result.source.fetchedAt).toBe(new Date(storedAt).toISOString());
	});
});
