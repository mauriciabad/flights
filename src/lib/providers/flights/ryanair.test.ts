import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import activeAirportsFixture from './fixtures/active-airports.json';
import oneWayFaresSingleFixture from './fixtures/one-way-fares-single-route.json';
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
		// One request for the fares, one for the network snapshot (also cold).
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

	describe('an expired fare entry (issue #147)', () => {
		/** Ages every entry in `store` by `ms`, by rewriting `storedAt` in place. Cleaner
		 * than faking timers: the adapter reads `Date.now()` in three places and the cache
		 * store in two, and moving the clock under both is how the last round of
		 * cache-expiry tests ended up asserting on their own mock rather than the code. */
		async function ageStoredEntriesBy(store: MemoryCacheStore, ms: number, keys: string[]) {
			for (const key of keys) {
				const entry = await store.get(key);
				if (entry) await store.set({ ...entry, storedAt: entry.storedAt - ms });
			}
		}

		/** Both keys this adapter writes under, discovered rather than hardcoded, since
		 * `defineCacheKey` hashes the query and the hash is not this test's business. */
		async function keysIn(store: MemoryCacheStore, seed: () => Promise<unknown>) {
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

		it('is served immediately with its real age, rather than discarded for a fresh fetch', async () => {
			const store = new MemoryCacheStore();
			const provider = createRyanairFlightProvider({ store, fetchImpl: fixtureFetch() });
			const keys = await keysIn(store, () =>
				provider.searchOffers(query, { signal: new AbortController().signal })
			);

			const twoHours = 2 * 60 * 60_000;
			await ageStoredEntriesBy(store, twoHours, keys);
			const before = Date.now();
			const result = await provider.searchOffers(query, { signal: new AbortController().signal });

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.data).toHaveLength(1);
			// The whole point: the caller got the answer without waiting on the fare fetch,
			// and it is labelled with when the price was really read, not with "now".
			const ageMs = before - Date.parse(result.source.fetchedAt);
			expect(ageMs).toBeGreaterThanOrEqual(twoHours);
		});

		it('refreshes it behind the answer, and charges the request it issued', async () => {
			const store = new MemoryCacheStore();
			const provider = createRyanairFlightProvider({ store, fetchImpl: fixtureFetch() });
			const keys = await keysIn(store, () =>
				provider.searchOffers(query, { signal: new AbortController().signal })
			);
			await ageStoredEntriesBy(store, 2 * 60 * 60_000, keys);

			const callsBefore = fetchCallCount;
			const result = await provider.searchOffers(query, { signal: new AbortController().signal });

			// Reported as one request because one really was issued on this call's behalf,
			// even though the call did not wait for it.
			expect(result.requestsUsed).toBe(1);
			expect(fetchCallCount).toBeGreaterThan(callsBefore);

			// Waits for the WRITE, not just the fetch: the point of the refresh is the
			// entry it leaves behind, and a test that stops at "a request went out" would
			// pass against a refresh that fetched and then dropped the result on the floor.
			await vi.waitFor(async () => {
				const ages = await Promise.all(keys.map(async (key) => Date.now() - ((await store.get(key))?.storedAt ?? 0)));
				expect(Math.min(...ages)).toBeLessThan(60_000);
			});

			// And with it landed, the next call is an ordinary fresh hit again.
			const next = await provider.searchOffers(query, { signal: new AbortController().signal });
			expect(next.requestsUsed).toBe(0);
			expect(Date.now() - Date.parse(next.source.fetchedAt)).toBeLessThan(60_000);
		});

		it('does not refresh when the caller has no request budget left', async () => {
			const store = new MemoryCacheStore();
			const provider = createRyanairFlightProvider({ store, fetchImpl: fixtureFetch() });
			const keys = await keysIn(store, () =>
				provider.searchOffers(query, { signal: new AbortController().signal })
			);
			await ageStoredEntriesBy(store, 2 * 60 * 60_000, keys);

			const callsBefore = fetchCallCount;
			const result = await provider.searchOffers(query, {
				signal: new AbortController().signal,
				maxRequests: 0
			});

			// Still answered from cache — running out of budget is a partial result, never
			// a failure, and the cached fares cost nothing to hand back.
			expect(result).toMatchObject({ ok: true, requestsUsed: 0 });
			if (!result.ok) return;
			expect(result.data).toHaveLength(1);
			expect(fetchCallCount).toBe(callsBefore);
		});

		it('keeps the cached fares and their age when the background refresh fails', async () => {
			const store = new MemoryCacheStore();
			let failFares = false;
			const fetchImpl = fixtureFetch({
				'https://services-api.ryanair.com': () =>
					failFares ? new Response(null, { status: 503 }) : new Response(JSON.stringify(oneWayFaresSingleFixture), { status: 200 })
			});
			const provider = createRyanairFlightProvider({ store, fetchImpl });
			const keys = await keysIn(store, () =>
				provider.searchOffers(query, { signal: new AbortController().signal })
			);
			await ageStoredEntriesBy(store, 2 * 60 * 60_000, keys);
			failFares = true;

			const callsBefore = fetchCallCount;
			const result = await provider.searchOffers(query, { signal: new AbortController().signal });
			expect(result.ok).toBe(true);
			await vi.waitFor(() => expect(fetchCallCount).toBeGreaterThan(callsBefore));

			// A failed background refresh is invisible: the same fares, still dated when
			// they were really read, and no rejection anywhere.
			const next = await provider.searchOffers(query, { signal: new AbortController().signal });
			expect(next.ok).toBe(true);
			if (!next.ok || !result.ok) return;
			expect(next.data).toEqual(result.data);
			expect(Date.now() - Date.parse(next.source.fetchedAt)).toBeGreaterThan(60 * 60_000);
		});
	});

	it('reuses the already-cached network snapshot across different routes', async () => {
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
		// but the snapshot from the first call is still fresh (0 requests for it).
		expect(result.requestsUsed).toBe(1);
	});

	it('issues one snapshot request, not one per caller, for a concurrent fan-out (issue #121)', async () => {
		// The real failure this guards: a search fans searchOffers out across many
		// candidate routes at once, every one of them misses the cold snapshot cache, and
		// one measured search fetched the same 278 KB active-airports table twelve times.
		let snapshotCalls = 0;
		const fetchImpl = fixtureFetch({
			'https://www.ryanair.com/api/views/locate/3/airports/en/active': () => {
				snapshotCalls++;
				return new Response(JSON.stringify(activeAirportsFixture), { status: 200 });
			}
		});
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const results = await Promise.all(
			['STN', 'AHO', 'BHX', 'STN'].map((destination) =>
				provider.searchOffers({ ...query, destination }, { signal: new AbortController().signal })
			)
		);

		expect(snapshotCalls).toBe(1);
		// Exactly one of the four is charged for it; the rest joined the same request.
		expect(results.reduce((total, r) => total + r.requestsUsed, 0)).toBe(results.length + 1);
	});

	it('still maps offers when the snapshot fetch fails, using the snapshot shipped with the app', async () => {
		const fetchImpl = fixtureFetch({
			'https://www.ryanair.com/api/views/locate/3/airports/en/active': () =>
				new Response(null, { status: 503 })
		});
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// BCN and STN are both real Ryanair airports, so the bundled snapshot has their
		// zones and the fare still maps. Before issue #121 this returned zero offers.
		expect(result.data).toHaveLength(1);
		expect(result.data[0]?.departure.timeZone).toBe('Europe/Madrid');
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
		expect(result.data).toEqual(expect.arrayContaining(['AHO', 'BHX', 'STN']));
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

	it('answers for every other airport too, without a second request (issue #121)', async () => {
		// The whole point of the change. `algorithm/connections.ts` asks this once per
		// candidate airport, 80 distinct airports on a measured BCN->OTP search, and before
		// this each one of those was its own request to Ryanair.
		const store = new MemoryCacheStore();
		const provider = createRyanairFlightProvider({ store, fetchImpl: fixtureFetch() });

		await provider.listDirectDestinations('BCN', { signal: new AbortController().signal });
		const callsAfterFirst = fetchCallCount;

		for (const origin of ['STN', 'AHO', 'BHX', 'DUS', 'IST']) {
			const result = await provider.listDirectDestinations(origin, { signal: new AbortController().signal });
			expect(result.requestsUsed).toBe(0);
		}
		expect(fetchCallCount).toBe(callsAfterFirst);
	});

	it('answers an airport Ryanair does not serve with an empty list, not an error, and logs nothing (issue #89)', async () => {
		// DUS stands in for the real airports (DUS, ZRH, CDG, ...) issue #89 measured
		// against. They are simply absent from the active-airports response, which is the
		// same fact the deleted per-airport endpoint spent a 404 stating. Never worth a
		// console error, and now never worth a request either.
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.listDirectDestinations('DUS', { signal: new AbortController().signal });

		expect(result).toMatchObject({ ok: true, data: [] });
		expect(consoleError).not.toHaveBeenCalled();
		expect(consoleWarn).not.toHaveBeenCalled();

		consoleError.mockRestore();
		consoleWarn.mockRestore();
	});

	it('falls back to the snapshot shipped with the app when Ryanair is unreachable', async () => {
		// Before issue #121 an unreachable Ryanair meant an empty candidate list and a
		// search that silently found nothing. The bundled route graph is the floor.
		const fetchImpl = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.listDirectDestinations('BCN', { signal: new AbortController().signal });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.length).toBeGreaterThan(20);
		expect(result.data).toContain('STN');
	});

	it('answers from the bundled snapshot without spending a request when maxRequests is 0', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.listDirectDestinations('BCN', {
			signal: new AbortController().signal,
			maxRequests: 0
		});

		expect(result).toMatchObject({ ok: true, requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
		if (!result.ok) return;
		expect(result.data).toContain('STN');
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
