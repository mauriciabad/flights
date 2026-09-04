import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import activeAirportsFixture from './fixtures/active-airports.json';
import oneWayFaresSingleFixture from './fixtures/one-way-fares-single-route.json';
import routesBcnFixture from './fixtures/routes-bcn.json';
import { createRyanairFlightProvider } from './ryanair';

/**
 * Exercises the adapter end to end — cache, mapping and error handling together — with a
 * fake `fetch` that resolves fixtures keyed by URL, so nothing here touches the network.
 * A real network round trip against the live Ryanair endpoints is done by hand, once,
 * during development; see the PR description for that result, since a live call has no
 * place in a suite that must run the same way in CI as on a disconnected laptop.
 */

let fetchCallCount = 0;

function fixtureFetch(overrides: Record<string, () => Response> = {}): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		fetchCallCount++;
		const url = input.toString();
		for (const [prefix, respond] of Object.entries(overrides)) {
			if (url.startsWith(prefix)) return respond();
		}
		if (url.startsWith('https://services-api.ryanair.com/farfnd/v4/oneWayFares')) {
			return new Response(JSON.stringify(oneWayFaresSingleFixture), { status: 200 });
		}
		if (url.startsWith('https://www.ryanair.com/api/views/locate/searchWidget/routes/en/airport/')) {
			return new Response(JSON.stringify(routesBcnFixture), { status: 200 });
		}
		if (url === 'https://www.ryanair.com/api/views/locate/3/airports/en/active') {
			return new Response(JSON.stringify(activeAirportsFixture), { status: 200 });
		}
		throw new Error(`fixtureFetch: no stub configured for ${url}`);
	}) as typeof fetch;
}

const query = {
	origin: 'BCN',
	destination: 'STN',
	earliestDeparture: '2026-10-01',
	latestDeparture: '2026-10-20'
};

beforeEach(() => {
	fetchCallCount = 0;
});

describe('searchOffers', () => {
	it('returns real, mapped offers on a cold cache', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(query, { signal: new AbortController().signal });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(1);
		expect(result.data[0]).toMatchObject({
			flightNumber: 'FR8231',
			departureAirport: 'BCN',
			arrivalAirport: 'STN',
			price: { minorUnits: 1499, currency: 'EUR' }
		});
		expect(result.source.providerId).toBe('ryanair');
		// One request for the fares, one for the airport-timezone table (also cold).
		expect(result.requestsUsed).toBe(2);
	});

	it('serves the second identical call from cache, spending no requests', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		const provider = createRyanairFlightProvider({ store, fetchImpl });

		const first = await provider.searchOffers(query, { signal: new AbortController().signal });
		const callsAfterFirst = fetchCallCount;
		const second = await provider.searchOffers(query, { signal: new AbortController().signal });

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.data).toEqual(first.data);
		expect(second.requestsUsed).toBe(0);
		expect(second.source.providerId).toBe('ryanair');
		expect(fetchCallCount).toBe(callsAfterFirst); // no new network calls
	});

	it('reuses the already-cached airport-timezone table across different routes', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		const provider = createRyanairFlightProvider({ store, fetchImpl });

		await provider.searchOffers(query, { signal: new AbortController().signal });
		const result = await provider.searchOffers(
			{ ...query, destination: 'AHO' },
			{ signal: new AbortController().signal }
		);

		expect(result.ok).toBe(true);
		// A different route is a different cache key for the fares themselves (1 request),
		// but the timezone table from the first call is still fresh (0 requests for it).
		expect(result.requestsUsed).toBe(1);
	});

	it('resolves cancelled, not a rejected promise, for an already-aborted signal', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const controller = new AbortController();
		controller.abort();

		const result = await provider.searchOffers(query, { signal: controller.signal });
		expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' }, requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
	});

	it('stops before spending anything when maxRequests is 0, returning an empty ok result', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(query, { signal: new AbortController().signal, maxRequests: 0 });

		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
	});

	it('maps a network failure to a typed error without throwing', async () => {
		const fetchImpl = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal });
		expect(result).toMatchObject({ ok: false, error: { code: 'network-error' }, requestsUsed: 1 });
	});

	it('maps a 429 to quota-exceeded without throwing', async () => {
		const fetchImpl = fixtureFetch({
			'https://services-api.ryanair.com': () => new Response(null, { status: 429 })
		});
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal });
		expect(result).toMatchObject({ ok: false, error: { code: 'quota-exceeded', status: 429 }, requestsUsed: 1 });
	});

	it('reports zero cost, unconditionally', () => {
		const provider = createRyanairFlightProvider();
		expect(provider.estimateSearchOffersCost(query)).toBe(0);
	});
});

describe('listDirectDestinations', () => {
	it('returns a non-empty list of IATA codes for a big base (BCN)', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.listDirectDestinations('BCN', { signal: new AbortController().signal });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.length).toBeGreaterThan(0);
		expect(result.data).toEqual(expect.arrayContaining(['AGP', 'AHO', 'STN']));
		expect(result.requestsUsed).toBe(1);
	});

	it('serves a second call for the same origin from cache', async () => {
		const store = new MemoryCacheStore();
		const provider = createRyanairFlightProvider({ store, fetchImpl: fixtureFetch() });

		await provider.listDirectDestinations('BCN', { signal: new AbortController().signal });
		const callsAfterFirst = fetchCallCount;
		const second = await provider.listDirectDestinations('BCN', { signal: new AbortController().signal });

		expect(second.requestsUsed).toBe(0);
		expect(fetchCallCount).toBe(callsAfterFirst);
	});

	it('resolves cancelled for an already-aborted signal', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const controller = new AbortController();
		controller.abort();

		const result = await provider.listDirectDestinations('BCN', { signal: controller.signal });
		expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
	});
});

describe('healthCheck', () => {
	it('is ok when the active-airports endpoint returns airports', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.healthCheck({ signal: new AbortController().signal });
		expect(result).toMatchObject({ ok: true, requestsUsed: 1 });
	});

	it('never throws when Ryanair is unreachable', async () => {
		const fetchImpl = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.healthCheck({ signal: new AbortController().signal });
		expect(result).toMatchObject({ ok: false, error: { code: 'network-error' } });
	});
});

describe('provider identity', () => {
	it('declares itself keyless', () => {
		const provider = createRyanairFlightProvider();
		expect(provider.needsKey).toBe(false);
		expect(provider.keyFields).toEqual([]);
		expect(provider.kind).toBe('flight');
		expect(provider.id).toBe('ryanair');
	});
});
