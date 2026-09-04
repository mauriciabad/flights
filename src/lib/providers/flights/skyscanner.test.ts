import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import { clearInFlightForTests, clearProviderQuotaStateForTests, resetPermanentFailuresForTests } from '../budget';
import searchAirportBcn from './fixtures/search-airport-bcn.json';
import searchAirportVie from './fixtures/search-airport-vie.json';
import searchFlightsBcnVie from './fixtures/search-flights-bcn-vie.json';
import { setCachedAirportEntity } from './skyscanner-airport-cache';
import { createSkyscannerFlightProvider } from './skyscanner';

/**
 * Every test here runs entirely off the real fixtures captured for issue #5 (see
 * fixtures/*.json and the PR description for exactly which five live RapidAPI calls
 * produced them) through a fake `fetch`. Nothing in this file, or anything it imports,
 * reaches the network: that is the whole point of spending the request budget once, up
 * front, to build fixtures, rather than re-hitting Sky Scrapper's 20-requests-a-month free
 * tier from CI on every run.
 *
 * Issue #69: this adapter now routes every real request through `callProviderWithBudget`
 * (../budget), which keeps module-level state (in-flight dedup, the permanently-
 * unsubscribed set, and a `localStorage`-backed monthly counter) that must be reset between
 * tests — same as flights-sky.test.ts does — or one test's "not-subscribed" or quota spend
 * leaks into the next.
 */
const instantSleep = async () => {};

beforeEach(() => {
	localStorage.clear();
	clearInFlightForTests();
	resetPermanentFailuresForTests();
	clearProviderQuotaStateForTests();
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

interface FakeRoutes {
	searchAirport?: (query: string) => Response;
	searchFlights?: (date: string) => Response;
}

function fakeFetch(routes: FakeRoutes) {
	// Typed against fetch's real parameter shape (RequestInfo | URL), not just the plain
	// string this adapter happens to call it with, so this mock is assignable to
	// `typeof fetch` with no cast, and keeps its vi.Mock methods (mockClear, and the
	// toHaveBeenCalledTimes matcher below) intact for assertions.
	return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
		const urlString = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
		const url = new URL(urlString);
		if (url.pathname.endsWith('/searchAirport')) {
			const query = url.searchParams.get('query') ?? '';
			if (routes.searchAirport) return routes.searchAirport(query);
		}
		if (url.pathname.endsWith('/searchFlights')) {
			const date = url.searchParams.get('date') ?? '';
			if (routes.searchFlights) return routes.searchFlights(date);
		}
		throw new Error(`unmocked request in test: ${url.toString()}`);
	});
}

/** Default happy-path routing: BCN and VIE resolve via the real captured airport lookups,
 * any date's fare search returns the real captured BCN-VIE response. */
function happyPathFetch() {
	return fakeFetch({
		searchAirport: (query) => {
			if (query.toUpperCase() === 'BCN') return jsonResponse(200, searchAirportBcn);
			if (query.toUpperCase() === 'VIE') return jsonResponse(200, searchAirportVie);
			return jsonResponse(200, { status: true, data: [] });
		},
		searchFlights: () => jsonResponse(200, searchFlightsBcnVie)
	});
}

const baseQuery = {
	origin: 'BCN',
	destination: 'VIE',
	earliestDeparture: '2026-10-15',
	latestDeparture: '2026-10-15'
};

function contextWithKey(overrides: Partial<import('../types').ProviderContext> = {}) {
	return {
		signal: new AbortController().signal,
		keys: { apiKey: 'test-key' },
		...overrides
	};
}

describe('createSkyscannerFlightProvider', () => {
	it('declares itself as a keyed flight provider', () => {
		const provider = createSkyscannerFlightProvider();
		expect(provider.kind).toBe('flight');
		expect(provider.id).toBe('skyscanner');
		expect(provider.needsKey).toBe(true);
		expect(provider.keyFields.map((field) => field.id)).toEqual(['apiKey']);
	});

	describe('estimateSearchOffersCost', () => {
		it('counts one request per day in the range, since searchFlights takes one date at a time', () => {
			const provider = createSkyscannerFlightProvider();
			expect(
				provider.estimateSearchOffersCost({
					...baseQuery,
					earliestDeparture: '2026-10-15',
					latestDeparture: '2026-10-17'
				})
			).toBe(3);
		});

		it('is 1 for a single day', () => {
			const provider = createSkyscannerFlightProvider();
			expect(provider.estimateSearchOffersCost(baseQuery)).toBe(1);
		});
	});

	describe('searchOffers', () => {
		it('reports missing-key with no network call when no key is configured', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const result = await provider.searchOffers(baseQuery, { signal: new AbortController().signal });
			expect(result).toMatchObject({ ok: false, error: { code: 'missing-key' }, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('reports cancelled with no network call when the signal is already aborted', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const controller = new AbortController();
			controller.abort();
			const result = await provider.searchOffers(baseQuery, {
				signal: controller.signal,
				keys: { apiKey: 'k' }
			});
			expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' }, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('resolves both airports then searches, returning only the direct offers, on a cold cache', async () => {
			const fetchImpl = happyPathFetch();
			const cacheStore = new MemoryCacheStore();
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore });
			const result = await provider.searchOffers(baseQuery, contextWithKey());
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data.map((offer) => offer.flightNumber)).toEqual(['VY8714', 'FR12']);
				// 2 airport lookups (cold cache) + 1 fare search for the single requested date.
				expect(result.requestsUsed).toBe(3);
			}
			expect(fetchImpl).toHaveBeenCalledTimes(3);
		});

		it('spends no requests on airport lookups once both are warm in the cache', async () => {
			const cacheStore = new MemoryCacheStore();
			await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, cacheStore);
			await setCachedAirportEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, cacheStore);
			const fetchImpl = fakeFetch({ searchFlights: () => jsonResponse(200, searchFlightsBcnVie) });
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore });
			const result = await provider.searchOffers(baseQuery, contextWithKey());
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.requestsUsed).toBe(1);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});

		it('refuses the call before firing any fetch once the monthly cap is already spent', async () => {
			// Issue #69's own scenario: Sky Scrapper's real cap is 20/month and one careless
			// search must not be able to spend it all. `cap: 0` simulates the month's budget
			// already being gone — `callProviderWithBudget` (../budget) has to refuse before
			// ever reaching `fetchImpl`, not after.
			const cacheStore = new MemoryCacheStore();
			await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, cacheStore);
			await setCachedAirportEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, cacheStore);
			const fetchImpl = fakeFetch({ searchFlights: () => jsonResponse(200, searchFlightsBcnVie) });
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore, cap: 0 });
			const result = await provider.searchOffers(baseQuery, contextWithKey());
			expect(result).toMatchObject({ ok: false, error: { code: 'quota-exceeded' }, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('makes one network request for two concurrent identical searches, not two', async () => {
			// A 20-request monthly budget cannot survive two components (or a fast double
			// click) firing the same search before the first settles — see
			// ../budget/dedupe.ts's own header for why this matters more here than it would
			// for an unmetered provider.
			const cacheStore = new MemoryCacheStore();
			await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, cacheStore);
			await setCachedAirportEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, cacheStore);
			const fetchImpl = fakeFetch({ searchFlights: () => jsonResponse(200, searchFlightsBcnVie) });
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore });

			const [first, second] = await Promise.all([
				provider.searchOffers(baseQuery, contextWithKey()),
				provider.searchOffers(baseQuery, contextWithKey())
			]);

			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(first.ok).toBe(true);
			expect(second.ok).toBe(true);
			if (first.ok && second.ok) {
				expect(first.requestsUsed).toBe(1);
				expect(second.requestsUsed).toBe(1); // shares the first call's outcome, not a second reservation
				expect(second.data).toEqual(first.data);
			}
		});

		it('caches a resolved airport so a second search for the same route does not look it up again', async () => {
			const cacheStore = new MemoryCacheStore();
			const fetchImpl = happyPathFetch();
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore });
			await provider.searchOffers(baseQuery, contextWithKey());
			fetchImpl.mockClear();
			const second = await provider.searchOffers(baseQuery, contextWithKey());
			expect(second.ok).toBe(true);
			if (second.ok) expect(second.requestsUsed).toBe(1); // fare search only, both airports now cached
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});

		it('spends one fare-search request per day across a multi-day range, up to the budget', async () => {
			const cacheStore = new MemoryCacheStore();
			await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, cacheStore);
			await setCachedAirportEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, cacheStore);
			const fetchImpl = fakeFetch({ searchFlights: () => jsonResponse(200, searchFlightsBcnVie) });
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore });
			const result = await provider.searchOffers(
				{ ...baseQuery, earliestDeparture: '2026-10-15', latestDeparture: '2026-10-19' },
				contextWithKey({ maxRequests: 2 })
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.requestsUsed).toBe(2);
				// Both fare-search calls hit the same fixture, so 2 direct offers each = 4.
				expect(result.data).toHaveLength(4);
			}
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		});

		it('returns an ok empty result, not an error, when the budget is fully spent resolving both airports', async () => {
			const fetchImpl = happyPathFetch();
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const result = await provider.searchOffers(baseQuery, contextWithKey({ maxRequests: 2 }));
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data).toEqual([]);
				expect(result.requestsUsed).toBe(2); // both lookups happened; nothing left for a fare search
			}
		});

		// docs/PROVIDERS.md's measured shape, replayed through the fake fetch rather than
		// triggered against the owner's real subscription.
		it('propagates a not-subscribed error and remembers it for the rest of the session', async () => {
			const fetchImpl = fakeFetch({
				searchAirport: () =>
					jsonResponse(403, { message: 'You are not subscribed to this API.' })
			});
			const cacheStore = new MemoryCacheStore();
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const first = await provider.searchOffers(baseQuery, contextWithKey());
			expect(first).toMatchObject({ ok: false, error: { code: 'not-subscribed' } });
			expect(fetchImpl).toHaveBeenCalledTimes(1);

			fetchImpl.mockClear();
			const second = await provider.searchOffers(baseQuery, contextWithKey());
			expect(second).toMatchObject({ ok: false, requestsUsed: 0, error: { code: 'not-subscribed' } });
			// Remembered for the session: the second call never touches the network at all.
			// Issue #69: this is now tracked per `ProviderId` by the shared budget module
			// (../budget/permanent-failures.ts), not per API key the way this adapter used to
			// hand-roll it — one consistent rule across every adapter wired to the module.
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('stops the date loop on quota-exceeded but keeps offers already collected', async () => {
			const cacheStore = new MemoryCacheStore();
			await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, cacheStore);
			await setCachedAirportEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, cacheStore);
			let call = 0;
			const fetchImpl = fakeFetch({
				searchFlights: () => {
					call += 1;
					if (call === 1) return jsonResponse(200, searchFlightsBcnVie);
					return jsonResponse(429, { message: 'Too Many Requests' }, { 'retry-after': '60' });
				}
			});
			// cap: 2 lets the first (successful) date through plus one attempt at the second
			// (429) date, then refuses the budget module's own retry of that same date before
			// it fires a second real fetch — a hard stop, not a guess at how many attempts
			// `callProviderWithBudget`'s default backoff would otherwise make.
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore, cap: 2, sleep: instantSleep });
			const result = await provider.searchOffers(
				{ ...baseQuery, earliestDeparture: '2026-10-15', latestDeparture: '2026-10-17' },
				contextWithKey()
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data).toHaveLength(2); // from the one successful date
				expect(result.requestsUsed).toBe(2); // 1 successful + 1 that hit the 429
			}
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		});

		it('surfaces quota-exceeded as an error when no offers were collected at all', async () => {
			const cacheStore = new MemoryCacheStore();
			await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, cacheStore);
			await setCachedAirportEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, cacheStore);
			const fetchImpl = fakeFetch({
				searchFlights: () => jsonResponse(429, { message: 'Too Many Requests' })
			});
			// cap: 1 lets the single attempt through and refuses the budget module's own
			// retry before it fires a second real fetch — see the cap comment above.
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore, cap: 1, sleep: instantSleep });
			const result = await provider.searchOffers(baseQuery, contextWithKey());
			expect(result).toMatchObject({ ok: false, error: { code: 'quota-exceeded' }, requestsUsed: 1 });
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});

		it('skips a malformed date and still returns the offers other dates produced', async () => {
			const cacheStore = new MemoryCacheStore();
			await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, cacheStore);
			await setCachedAirportEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, cacheStore);
			let call = 0;
			const fetchImpl = fakeFetch({
				searchFlights: () => {
					call += 1;
					if (call === 1) return jsonResponse(200, { status: true, data: { notItineraries: [] } });
					return jsonResponse(200, searchFlightsBcnVie);
				}
			});
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const result = await provider.searchOffers(
				{ ...baseQuery, earliestDeparture: '2026-10-15', latestDeparture: '2026-10-16' },
				contextWithKey()
			);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.data).toHaveLength(2);
		});
	});

	describe('listDirectDestinations', () => {
		it('reports it cannot answer, honestly, spending no request', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const result = await provider.listDirectDestinations('BCN', contextWithKey());
			expect(result).toMatchObject({ ok: false, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});
	});

	describe('healthCheck', () => {
		it('reports missing-key with no network call', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const result = await provider.healthCheck({ signal: new AbortController().signal });
			expect(result).toMatchObject({ ok: false, error: { code: 'missing-key' }, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('spends exactly one request and reports ok for a working key', async () => {
			const fetchImpl = happyPathFetch();
			const provider = createSkyscannerFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const result = await provider.healthCheck(contextWithKey());
			expect(result).toMatchObject({ ok: true, requestsUsed: 1 });
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});
	});
});
