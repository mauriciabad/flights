import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import { clearInFlightForTests, clearProviderQuotaStateForTests, resetPermanentFailuresForTests } from '../budget';
import { createAgodaStayProvider } from './agoda';
import agodaGetPricesWombats from './fixtures/agoda-get-prices-wombats-hostel.json';
import agodaSearchVienna from './fixtures/agoda-search-vienna.json';
import nominatimVienna from './fixtures/nominatim-vienna.json';

/**
 * Exercises the adapter end to end — reverse-geocoding, cache, mapping, budget and error
 * handling together — with a fake `fetch` that resolves fixtures keyed by URL, so nothing
 * here touches the network. Real network round trips against the live Agoda and Nominatim
 * endpoints were done by hand, once, during development; see the PR body for those exact
 * requests and results.
 *
 * Issue #69: this adapter now routes every real request through `callProviderWithBudget`
 * (../budget), which keeps module-level state (in-flight dedup, the permanently-
 * unsubscribed set, and a `localStorage`-backed monthly counter) that must be reset between
 * tests, same as flights-sky.test.ts does.
 */
const instantSleep = async () => {};

const EMPTY_GET_PRICES = { data: { currencyInfo: { code: 'USD' }, roomGridData: { masterRooms: [] } } };

let fetchCallCount = 0;
let searchUrlsSeen: string[] = [];

function fixtureFetch(overrides: Record<string, () => Response> = {}): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		fetchCallCount++;
		const url = input.toString();
		for (const [prefix, respond] of Object.entries(overrides)) {
			if (url.startsWith(prefix)) return respond();
		}
		if (url.startsWith('https://nominatim.openstreetmap.org/reverse')) {
			return new Response(JSON.stringify(nominatimVienna), { status: 200 });
		}
		if (url.startsWith('https://agoda-com.p.rapidapi.com/hotels-homes/overnight-stays/search')) {
			searchUrlsSeen.push(url);
			return new Response(JSON.stringify(agodaSearchVienna), { status: 200 });
		}
		if (url.startsWith('https://agoda-com.p.rapidapi.com/hotels-homes/get-prices')) {
			const propertyId = new URL(url).searchParams.get('property_id');
			const body = propertyId === '417108' ? agodaGetPricesWombats : EMPTY_GET_PRICES;
			return new Response(JSON.stringify(body), { status: 200 });
		}
		throw new Error(`fixtureFetch: no stub configured for ${url}`);
	}) as typeof fetch;
}

const query = {
	near: { latitude: 48.1103, longitude: 16.5697 }, // VIE airport coordinates
	radiusKm: 25,
	checkIn: '2026-10-10',
	checkOut: '2026-10-12'
};

const apiKeys = { apiKey: 'test-key' };

beforeEach(() => {
	fetchCallCount = 0;
	searchUrlsSeen = [];
	localStorage.clear();
	clearInFlightForTests();
	resetPermanentFailuresForTests();
	clearProviderQuotaStateForTests();
});

describe('searchStays', () => {
	it('reverse-geocodes, searches, and drills into every affordable candidate on a cold cache', async () => {
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// 1 search + drill-downs for all 3 non-sold-out candidates (Wombat's, Wahringer,
		// Mercure — Spark by Hilton is filtered out as sold out).
		expect(result.requestsUsed).toBe(4);
		expect(result.source.providerId).toBe('agoda');

		// The resolved label, not raw coordinates, is what actually reached Agoda.
		expect(searchUrlsSeen[0]).toContain('location=Vienna%2C+Austria');

		const byKind = Object.fromEntries(result.data.map((s) => [s.roomKind, s]));
		expect(byKind.dorm).toMatchObject({ pricePerNight: { minorUnits: 2946, currency: 'EUR' } });
		expect(byKind['female-dorm']).toMatchObject({ pricePerNight: { minorUnits: 3056, currency: 'EUR' } });
		expect(byKind.private).toBeDefined();
		// Cheapest first overall.
		expect(result.data[0].pricePerNight.minorUnits).toBeLessThanOrEqual(result.data[result.data.length - 1].pricePerNight.minorUnits);
	});

	it('resolves VIE coordinates through the local airport dataset, never touching Nominatim (issue #65)', async () => {
		// Before this fix, this exact query's coordinates reverse-geocoded through
		// Nominatim to "Fischamend" (docs/PROVIDERS.md), a real town of a few thousand
		// people that isn't Vienna. geocode/airport-city.ts now answers this from this
		// app's own OurAirports dataset before Nominatim is ever called.
		const fetchImpl = vi.fn(fixtureFetch());
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result.ok).toBe(true);
		expect(searchUrlsSeen[0]).toContain('location=Vienna%2C+Austria');
		const calledUrls = fetchImpl.mock.calls.map(([url]) => String(url));
		expect(calledUrls.some((url) => url.startsWith('https://nominatim.openstreetmap.org'))).toBe(false);
	});

	it('serves a second identical search entirely from cache', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		const provider = createAgodaStayProvider({ store, fetchImpl });

		const first = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });
		const callsAfterFirst = fetchCallCount;
		const second = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.requestsUsed).toBe(0);
		expect(fetchCallCount).toBe(callsAfterFirst);
	});

	it('spends no Agoda requests when reverse geocoding cannot place the coordinate', async () => {
		const fetchImpl = fixtureFetch({
			'https://nominatim.openstreetmap.org/reverse': () => new Response(JSON.stringify({ address: {} }), { status: 200 })
		});
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl });
		// A coordinate away from every airport in this app's dataset, so the local
		// airport-city lookup (issue #65) misses and this actually exercises the Nominatim
		// fallback the fixture above stubs out — the default `query.near` (VIE) now resolves
		// locally and would never reach Nominatim at all.
		const midPacific = { ...query, near: { latitude: 0, longitude: -160 } };
		const result = await provider.searchStays(midPacific, { signal: new AbortController().signal, keys: apiKeys });

		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
	});

	it('excludes every candidate outside the requested radius, still spending the one search request', async () => {
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays({ ...query, radiusKm: 0.01 }, { signal: new AbortController().signal, keys: apiKeys });

		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 1 });
	});

	it('caps drill-down requests at ctx.maxRequests, keeping the cheapest candidates first', async () => {
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays(query, {
			signal: new AbortController().signal,
			keys: apiKeys,
			maxRequests: 2 // 1 for the search, 1 left over for exactly one drill-down
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.requestsUsed).toBe(2);
		// Wombat's ($31.20) is the cheapest candidate, so it's the one that gets drilled.
		expect(result.data.some((s) => s.pricePerNight.currency === 'EUR')).toBe(true);
	});

	it('returns missing-key without spending any request when no key is configured', async () => {
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays(query, { signal: new AbortController().signal });

		expect(result).toMatchObject({ ok: false, error: { code: 'missing-key' }, requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
	});

	it('maps a 403 from Agoda to not-subscribed', async () => {
		const fetchImpl = fixtureFetch({
			'https://agoda-com.p.rapidapi.com/hotels-homes/overnight-stays/search': () =>
				new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
		});
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result).toMatchObject({ ok: false, error: { code: 'not-subscribed', status: 403 }, requestsUsed: 1 });
	});

	it('maps a 429 from Agoda to quota-exceeded', async () => {
		const fetchImpl = fixtureFetch({
			'https://agoda-com.p.rapidapi.com/hotels-homes/overnight-stays/search': () =>
				new Response('{}', { status: 429, headers: { 'retry-after': '30' } })
		});
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl, sleep: instantSleep });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		// `callProviderWithBudget` (../budget) retries a 429 with backoff before giving up —
		// every attempt here gets the same response, so it spends all 3 default attempts
		// (requestsUsed: 3) before reporting the last one's Retry-After hint.
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'quota-exceeded', status: 429, retryAfterSeconds: 30 },
			requestsUsed: 3
		});
	});

	it('maps Agoda’s own soft-error 200 (dead/rejected endpoint) to malformed-response, not zero results', async () => {
		// Issue #68's worked example, generalised: a scraper-API endpoint answering
		// `{"status":false,"message":"..."}` with HTTP 200 (docs/PROVIDERS.md documents this
		// exact shape for Agoda, and Sky Scrapper's own dead searchFlightEverywhere endpoint
		// for the same pattern elsewhere). Before this fix, agoda-client.ts's shape check
		// accepted any object, so this would have silently become "0 properties found"
		// rather than a reported failure.
		const fetchImpl = fixtureFetch({
			'https://agoda-com.p.rapidapi.com/hotels-homes/overnight-stays/search': () =>
				new Response(JSON.stringify({ status: false, message: 'Deprecated version.' }), { status: 200 })
		});
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.searchStays(query, { signal: new AbortController().signal, keys: apiKeys });

		expect(result).toMatchObject({ ok: false, error: { code: 'malformed-response' }, requestsUsed: 1 });
	});

	it('respects an already-cancelled signal without making any request', async () => {
		const controller = new AbortController();
		controller.abort();
		const provider = createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchStays(query, { signal: controller.signal, keys: apiKeys });

		expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' }, requestsUsed: 0 });
		expect(fetchCallCount).toBe(0);
	});
});

describe('estimateSearchStaysCost', () => {
	it('reports the worst case: one search plus a drill-down per candidate it would expand', () => {
		const provider = createAgodaStayProvider();
		expect(provider.estimateSearchStaysCost(query)).toBe(6);
	});
});
