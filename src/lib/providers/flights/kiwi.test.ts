import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import oneWayFixture from './fixtures/kiwi-one-way-bcn-otp.json';
import { createKiwiFlightProvider } from './kiwi';

/**
 * Exercises the adapter end to end — cache, mapping and error handling together — with a
 * fake `fetch` that resolves fixtures, mirroring ryanair.test.ts. This adapter's own
 * live-network attempt (after a real $0 BASIC-plan subscription) is documented in the PR
 * and in docs/PROVIDERS.md rather than run here: it returned 402/DEPLOYMENT_DISABLED, so a
 * suite that must pass the same way in CI as it did while writing this adapter cannot
 * depend on that backend coming back.
 */

let fetchCallCount = 0;

function fixtureFetch(overrides: Record<string, () => Response> = {}): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		fetchCallCount++;
		const url = input.toString();
		for (const [prefix, respond] of Object.entries(overrides)) {
			if (url.startsWith(prefix)) return respond();
		}
		if (url.startsWith('https://kiwi-com-cheap-flights.p.rapidapi.com/one-way')) {
			return new Response(JSON.stringify(oneWayFixture), { status: 200 });
		}
		throw new Error(`fixtureFetch: no stub configured for ${url}`);
	}) as typeof fetch;
}

const query = {
	origin: 'BCN',
	destination: 'OTP',
	earliestDeparture: '2026-10-12',
	latestDeparture: '2026-10-18'
};

const keys = { apiKey: 'test-rapidapi-key' };

beforeEach(() => {
	fetchCallCount = 0;
});

describe('searchOffers', () => {
	it('returns real, mapped offers on a cold cache, one per flight rather than one per itinerary', async () => {
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(3); // 1 nonstop + 2 legs of the self-transfer itinerary
		expect(result.source.providerId).toBe('kiwi');
		expect(result.requestsUsed).toBe(1);
	});

	it('serves the second identical call from cache, spending no requests', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		const provider = createKiwiFlightProvider({ store, fetchImpl });

		const first = await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		const callsAfterFirst = fetchCallCount;
		const second = await provider.searchOffers(query, { signal: new AbortController().signal, keys });

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.data).toEqual(first.data);
		expect(second.requestsUsed).toBe(0);
		expect(fetchCallCount).toBe(callsAfterFirst);
	});

	it('resolves missing-key rather than calling the network when no key is configured', async () => {
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(query, { signal: new AbortController().signal });
		expect(result).toMatchObject({ ok: false, error: { code: 'missing-key' }, requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
	});

	it('resolves cancelled, not a rejected promise, for an already-aborted signal', async () => {
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const controller = new AbortController();
		controller.abort();

		const result = await provider.searchOffers(query, { signal: controller.signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' }, requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
	});

	it('stops before spending anything when maxRequests is 0, returning an empty ok result', async () => {
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys, maxRequests: 0 });

		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
	});

	it('maps a 403 to not-subscribed without throwing, counting it as free (RapidAPI gateway rejection)', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () =>
				new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'not-subscribed', status: 403 }, requestsUsed: 0 });
	});

	it('remembers not-subscribed for the key and stops calling the network on a later search', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () =>
				new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		const callsAfterFirst = fetchCallCount;
		const second = await provider.searchOffers(query, { signal: new AbortController().signal, keys });

		expect(second).toMatchObject({ ok: false, error: { code: 'not-subscribed' }, requestsUsed: 0 });
		expect(fetchCallCount).toBe(callsAfterFirst); // no new network call for the remembered key
	});

	it('maps a 429 to quota-exceeded without throwing', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () => new Response(null, { status: 429 })
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'quota-exceeded', status: 429 }, requestsUsed: 1 });
	});

	it('maps the live 402/DEPLOYMENT_DISABLED case to unknown, not to a crash or a wrong code', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () =>
				new Response(JSON.stringify({ error: { code: '402', message: 'Payment required' } }), {
					status: 402,
					headers: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' }
				})
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'unknown' }, requestsUsed: 1 });
	});

	it('maps a network failure to a typed error without throwing, counting it as free (no response was ever received)', async () => {
		const fetchImpl = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'network-error' }, requestsUsed: 0 });
	});

	it('reports a cost of 1, unconditionally: this is a native date-range endpoint', () => {
		const provider = createKiwiFlightProvider();
		expect(provider.estimateSearchOffersCost(query)).toBe(1);
	});
});

describe('listDirectDestinations', () => {
	it('returns only nonstop-itinerary destinations, spending one request', async () => {
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.listDirectDestinations('BCN', { signal: new AbortController().signal, keys });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual(['VIE']);
		expect(result.requestsUsed).toBe(1);
	});

	it('serves a second call for the same origin from cache', async () => {
		const store = new MemoryCacheStore();
		const provider = createKiwiFlightProvider({ store, fetchImpl: fixtureFetch() });

		await provider.listDirectDestinations('BCN', { signal: new AbortController().signal, keys });
		const callsAfterFirst = fetchCallCount;
		const second = await provider.listDirectDestinations('BCN', { signal: new AbortController().signal, keys });

		expect(second.requestsUsed).toBe(0);
		expect(fetchCallCount).toBe(callsAfterFirst);
	});

	it('resolves missing-key rather than calling the network when no key is configured', async () => {
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.listDirectDestinations('BCN', { signal: new AbortController().signal });
		expect(result).toMatchObject({ ok: false, error: { code: 'missing-key' } });
		expect(fetchCallCount).toBe(0);
	});
});

describe('healthCheck', () => {
	it('is ok on a well-shaped response, regardless of whether any itinerary was found', async () => {
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.healthCheck({ signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: true, requestsUsed: 1 });
	});

	it('never throws when Kiwi is unreachable', async () => {
		const fetchImpl = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.healthCheck({ signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'network-error' } });
	});
});

describe('provider identity', () => {
	it('declares itself as needing a RapidAPI key', () => {
		const provider = createKiwiFlightProvider();
		expect(provider.needsKey).toBe(true);
		expect(provider.keyFields.map((f) => f.id)).toEqual(['apiKey']);
		expect(provider.kind).toBe('flight');
		expect(provider.id).toBe('kiwi');
	});
});
