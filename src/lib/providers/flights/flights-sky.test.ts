import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import { clearInFlightForTests, clearProviderQuotaStateForTests, resetPermanentFailuresForTests } from '../budget';
import type { ProviderContext } from '../types';
import autoCompleteBarcelona from './fixtures/flights-sky-auto-complete-barcelona.json';
import autoCompleteVienna from './fixtures/flights-sky-auto-complete-vienna.json';
import priceCalendarBcnVie from './fixtures/flights-sky-price-calendar-bcn-vie.json';
import searchOneWayBcnVie from './fixtures/flights-sky-search-one-way-bcn-vie.json';
import { createFlightsSkyFlightProvider } from './flights-sky';
import { setCachedEntity } from './flights-sky-entity-cache';

/**
 * Every test here runs entirely off the real fixtures captured for issue #61 (see
 * fixtures/flights-sky-*.json and the PR description for exactly which five live RapidAPI
 * calls produced them) through a fake `fetch`. Nothing in this file, or anything it imports,
 * reaches the network.
 *
 * The budget module (../budget) keeps module-level state (in-flight dedup, the
 * permanently-unsubscribed set, and a `localStorage`-backed monthly counter) that must be
 * reset between tests, same as call-with-budget.test.ts does — otherwise one test's
 * "not-subscribed" or quota spend would leak into the next.
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
	autoComplete?: (query: string) => Response;
	priceCalendar?: () => Response;
	searchOneWay?: (departDate: string) => Response;
}

function fakeFetch(routes: FakeRoutes) {
	return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
		const urlString = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
		const url = new URL(urlString);
		if (url.pathname.endsWith('/auto-complete')) {
			const query = url.searchParams.get('query') ?? '';
			if (routes.autoComplete) return routes.autoComplete(query);
		}
		if (url.pathname.endsWith('/price-calendar')) {
			if (routes.priceCalendar) return routes.priceCalendar();
		}
		if (url.pathname.endsWith('/search-one-way')) {
			const departDate = url.searchParams.get('departDate') ?? '';
			if (routes.searchOneWay) return routes.searchOneWay(departDate);
		}
		throw new Error(`unmocked request in test: ${url.toString()}`);
	});
}

/** Cold-cache happy-path routing: BCN and VIE resolve via the real captured auto-complete
 * responses, any date's search-one-way returns the real captured BCN-VIE response, and the
 * calendar call returns the real captured full-year response. */
function happyPathFetch() {
	return fakeFetch({
		autoComplete: (query) => {
			if (query.toUpperCase() === 'BCN') return jsonResponse(200, autoCompleteBarcelona);
			if (query.toUpperCase() === 'VIE') return jsonResponse(200, autoCompleteVienna);
			return jsonResponse(200, { status: true, data: [] });
		},
		priceCalendar: () => jsonResponse(200, priceCalendarBcnVie),
		searchOneWay: () => jsonResponse(200, searchOneWayBcnVie)
	});
}

const baseQuery = {
	origin: 'BCN',
	destination: 'VIE',
	earliestDeparture: '2026-09-19',
	latestDeparture: '2026-09-19'
};

const baseCalendarQuery = { origin: 'BCN', destination: 'VIE', departDate: '2026-10-15' };

function contextWithKey(overrides: Partial<ProviderContext> = {}): ProviderContext {
	return {
		signal: new AbortController().signal,
		keys: { apiKey: 'test-key' },
		...overrides
	};
}

async function warmEntityCache(cacheStore: MemoryCacheStore) {
	await setCachedEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, cacheStore);
	await setCachedEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, cacheStore);
}

describe('createFlightsSkyFlightProvider', () => {
	it('declares itself as a keyed flight provider with the calendar capability', () => {
		const provider = createFlightsSkyFlightProvider();
		expect(provider.kind).toBe('flight');
		expect(provider.id).toBe('flights-sky');
		expect(provider.needsKey).toBe(true);
		expect(provider.keyFields.map((field) => field.id)).toEqual(['apiKey']);
		expect(typeof provider.getPriceCalendar).toBe('function');
	});

	describe('estimateSearchOffersCost', () => {
		it('counts one request per day in the range, since search-one-way takes one date at a time', () => {
			const provider = createFlightsSkyFlightProvider();
			expect(
				provider.estimateSearchOffersCost({ ...baseQuery, earliestDeparture: '2026-09-19', latestDeparture: '2026-09-21' })
			).toBe(3);
		});

		it('is 1 for a single day', () => {
			const provider = createFlightsSkyFlightProvider();
			expect(provider.estimateSearchOffersCost(baseQuery)).toBe(1);
		});
	});

	describe('estimatePriceCalendarCost', () => {
		it('is always 1, regardless of the query — the entire point of this capability', () => {
			const provider = createFlightsSkyFlightProvider();
			expect(provider.estimatePriceCalendarCost(baseCalendarQuery)).toBe(1);
		});
	});

	describe('searchOffers', () => {
		it('reports missing-key with no network call when no key is configured', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const result = await provider.searchOffers(baseQuery, { signal: new AbortController().signal });
			expect(result).toMatchObject({ ok: false, error: { code: 'missing-key' }, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('reports cancelled with no network call when the signal is already aborted', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const controller = new AbortController();
			controller.abort();
			const result = await provider.searchOffers(baseQuery, { signal: controller.signal, keys: { apiKey: 'k' } });
			expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' }, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('resolves both entities then searches, keeping only the 6 direct offers, on a cold cache', async () => {
			const fetchImpl = happyPathFetch();
			const cacheStore = new MemoryCacheStore();
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const result = await provider.searchOffers(baseQuery, contextWithKey());
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data).toHaveLength(6); // 4 of the fixture's 10 itineraries are one-stop connections
				// 2 entity lookups (cold cache) + 1 search-one-way for the single requested date.
				expect(result.requestsUsed).toBe(3);
			}
			expect(fetchImpl).toHaveBeenCalledTimes(3);
		});

		it('spends no requests on entity lookups once both are warm in the cache', async () => {
			const cacheStore = new MemoryCacheStore();
			await warmEntityCache(cacheStore);
			const fetchImpl = fakeFetch({ searchOneWay: () => jsonResponse(200, searchOneWayBcnVie) });
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const result = await provider.searchOffers(baseQuery, contextWithKey());
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.requestsUsed).toBe(1);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});

		it('serves a repeated identical search from cache, spending nothing', async () => {
			const cacheStore = new MemoryCacheStore();
			await warmEntityCache(cacheStore);
			const fetchImpl = fakeFetch({ searchOneWay: () => jsonResponse(200, searchOneWayBcnVie) });
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			await provider.searchOffers(baseQuery, contextWithKey());
			fetchImpl.mockClear();
			const second = await provider.searchOffers(baseQuery, contextWithKey());
			expect(second.ok).toBe(true);
			if (second.ok) {
				expect(second.requestsUsed).toBe(0);
				expect(second.data).toHaveLength(6);
			}
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('spends one search request per day across a multi-day range, up to the budget', async () => {
			const cacheStore = new MemoryCacheStore();
			await warmEntityCache(cacheStore);
			const fetchImpl = fakeFetch({ searchOneWay: () => jsonResponse(200, searchOneWayBcnVie) });
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const result = await provider.searchOffers(
				{ ...baseQuery, earliestDeparture: '2026-09-19', latestDeparture: '2026-09-23' },
				contextWithKey({ maxRequests: 2 })
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.requestsUsed).toBe(2);
				expect(result.data).toHaveLength(12); // 2 dates x 6 direct offers each
			}
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		});

		it('stops before exceeding the monthly cap and reports whatever it already spent', async () => {
			const fetchImpl = happyPathFetch();
			const cacheStore = new MemoryCacheStore();
			// cap: 1 lets the origin lookup through but refuses the destination lookup
			// before firing any request for it — reserveProviderRequests is a hard stop, not
			// a soft warning.
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, cap: 1, sleep: instantSleep });
			const result = await provider.searchOffers(baseQuery, contextWithKey());
			expect(result).toMatchObject({ ok: false, error: { code: 'quota-exceeded' }, requestsUsed: 1 });
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});

		it('remembers a not-subscribed 403 and refuses a later call without touching the network again', async () => {
			const fetchImpl = fakeFetch({
				autoComplete: () => jsonResponse(403, { message: 'You are not subscribed to this API.' })
			});
			const cacheStore = new MemoryCacheStore();
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const first = await provider.searchOffers(baseQuery, contextWithKey());
			expect(first).toMatchObject({ ok: false, error: { code: 'not-subscribed' } });
			expect(fetchImpl).toHaveBeenCalledTimes(1);

			fetchImpl.mockClear();
			const second = await provider.searchOffers(baseQuery, contextWithKey());
			expect(second).toMatchObject({ ok: false, requestsUsed: 0, error: { code: 'not-subscribed' } });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('skips a malformed date and still returns the offers other dates produced', async () => {
			const cacheStore = new MemoryCacheStore();
			await warmEntityCache(cacheStore);
			const fetchImpl = fakeFetch({
				searchOneWay: (departDate) => {
					if (departDate === '2026-09-19') return jsonResponse(200, { data: { notItineraries: [] } });
					return jsonResponse(200, searchOneWayBcnVie);
				}
			});
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const result = await provider.searchOffers(
				{ ...baseQuery, earliestDeparture: '2026-09-19', latestDeparture: '2026-09-20' },
				contextWithKey()
			);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.data).toHaveLength(6); // only the second date's 6 direct offers
		});

		it('surfaces quota-exceeded as an error when no offers were collected at all', async () => {
			const cacheStore = new MemoryCacheStore();
			await warmEntityCache(cacheStore);
			const fetchImpl = fakeFetch({ searchOneWay: () => jsonResponse(429, { message: 'Too Many Requests' }) });
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const result = await provider.searchOffers(baseQuery, contextWithKey());
			expect(result).toMatchObject({ ok: false, error: { code: 'quota-exceeded' } });
		});
	});

	describe('getPriceCalendar', () => {
		it('reports missing-key with no network call', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const result = await provider.getPriceCalendar(baseCalendarQuery, { signal: new AbortController().signal });
			expect(result).toMatchObject({ ok: false, error: { code: 'missing-key' }, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('reports cancelled with no network call when the signal is already aborted', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const controller = new AbortController();
			controller.abort();
			const result = await provider.getPriceCalendar(baseCalendarQuery, {
				signal: controller.signal,
				keys: { apiKey: 'k' }
			});
			expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('resolves both entities then fetches a full year of prices in one call, on a cold cache', async () => {
			const fetchImpl = happyPathFetch();
			const cacheStore = new MemoryCacheStore();
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const result = await provider.getPriceCalendar(baseCalendarQuery, contextWithKey());
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data).toHaveLength(366);
				// 2 entity lookups (cold cache) + 1 calendar call — this capability's whole
				// point, regardless of how the caller's own window is shaped.
				expect(result.requestsUsed).toBe(3);
			}
			expect(fetchImpl).toHaveBeenCalledTimes(3);
		});

		it('spends nothing on a repeated identical calendar query within the cache TTL', async () => {
			const cacheStore = new MemoryCacheStore();
			await warmEntityCache(cacheStore);
			const fetchImpl = fakeFetch({ priceCalendar: () => jsonResponse(200, priceCalendarBcnVie) });
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			await provider.getPriceCalendar(baseCalendarQuery, contextWithKey());
			fetchImpl.mockClear();
			const second = await provider.getPriceCalendar(baseCalendarQuery, contextWithKey());
			expect(second.ok).toBe(true);
			if (second.ok) {
				expect(second.requestsUsed).toBe(0);
				expect(second.data).toHaveLength(366);
			}
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('returns an ok empty result, not an error, when the per-call budget cannot afford the calendar request', async () => {
			const cacheStore = new MemoryCacheStore();
			await warmEntityCache(cacheStore);
			const fetchImpl = fakeFetch({});
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const result = await provider.getPriceCalendar(baseCalendarQuery, contextWithKey({ maxRequests: 0 }));
			expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('reports malformed-response when the calendar shape does not match what this adapter expects', async () => {
			const cacheStore = new MemoryCacheStore();
			await warmEntityCache(cacheStore);
			const fetchImpl = fakeFetch({ priceCalendar: () => jsonResponse(200, { data: { flights: {} } }) });
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore, sleep: instantSleep });
			const result = await provider.getPriceCalendar(baseCalendarQuery, contextWithKey());
			expect(result).toMatchObject({ ok: false, error: { code: 'malformed-response' } });
		});
	});

	describe('listDirectDestinations', () => {
		it('reports it cannot answer, honestly, spending no request', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const result = await provider.listDirectDestinations('BCN', contextWithKey());
			expect(result).toMatchObject({ ok: false, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});
	});

	describe('healthCheck', () => {
		it('reports missing-key with no network call', async () => {
			const fetchImpl = fakeFetch({});
			const provider = createFlightsSkyFlightProvider({ fetchImpl, cacheStore: new MemoryCacheStore() });
			const result = await provider.healthCheck({ signal: new AbortController().signal });
			expect(result).toMatchObject({ ok: false, error: { code: 'missing-key' }, requestsUsed: 0 });
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it('spends exactly one request and reports ok for a working key', async () => {
			const fetchImpl = happyPathFetch();
			const provider = createFlightsSkyFlightProvider({
				fetchImpl,
				cacheStore: new MemoryCacheStore(),
				sleep: instantSleep
			});
			const result = await provider.healthCheck(contextWithKey());
			expect(result).toMatchObject({ ok: true, requestsUsed: 1 });
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});
	});
});
