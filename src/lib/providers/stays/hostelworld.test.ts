import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import type { StaySearchQuery } from '../types';
import { createHostelworldStayProvider } from './hostelworld';
import continentEurope from './fixtures/hostelworld-continent-europe.json';
import continentNorthAmerica from './fixtures/hostelworld-continent-north-america.json';
import propertiesLondon from './fixtures/hostelworld-properties-london.json';

/**
 * Exercises the adapter end to end — the city index, ranking, cache, mapping and error
 * handling together — with a fake `fetch` resolving the fixtures captured on 2026-09-04, so
 * nothing here touches the network.
 *
 * Unlike agoda.test.ts and booking.test.ts there is no budget state to reset between tests:
 * this adapter is keyless and unmetered and never goes through `providers/budget` at all.
 * That absence is itself asserted below, because it is the whole point of the adapter.
 */
const CONTINENTS = 'https://api.m.hostelworld.com/2.2/continents/';
const PROPERTIES = 'https://api.m.hostelworld.com/2.2/cities/';

/** Hostelworld's world is six continents; only Europe carries the fixture's cities. The
 * other five answer with an empty country list, which is what a continent with nothing
 * relevant looks like to this adapter. */
const CONTINENT_COUNT = 6;
/** `MAX_CITY_CANDIDATES` in hostelworld.ts. Every one is asked now, not just the first that
 * answers — issue #204. */
const CITY_CANDIDATES = 3;
/** Six continent fetches, then every candidate city priced. */
const COLD_REQUESTS = CONTINENT_COUNT + CITY_CANDIDATES;

/** London Gatwick, the acceptance trip's connection airport. `resolveAirportCityLabel`
 * turns exactly this coordinate into "London, ..." from the bundled OurAirports dataset,
 * with no request spent — and that name is what puts London ahead of the nearer "Gatwick".
 * London is city id 3 in the fixture. */
const query: StaySearchQuery = {
	near: { latitude: 51.148744, longitude: -0.185739 },
	radiusKm: 100,
	checkIn: '2026-10-09',
	checkOut: '2026-10-12',
	currency: 'EUR'
};
const LONDON_CITY_ID = 3;
/** Hostelworld's own city for the airport, 2.0 km away, whose region is Horley — the two
 * properties the owner found on foot are in it (issue #204). */
const GATWICK_CITY_ID = 3671;
/** Third on the candidate list, 3.6 km out. */
const CRAWLEY_CITY_ID = 2582;

let urlsSeen: string[] = [];

/** Properties that exist, but on another continent — for the candidate walk. Vancouver. */
const ELSEWHERE = {
	properties: [
		{
			id: 1,
			name: 'Wrong Continent Hostel',
			latitude: 49.2827,
			longitude: -123.1207,
			lowestAverageDormPricePerNight: { value: '15.00', currency: 'EUR' }
		}
	]
};

function continentBody(url: string) {
	if (url.includes('/continents/3/')) return continentEurope;
	if (url.includes('/continents/1/')) return continentNorthAmerica;
	return { countries: [] };
}

function fixtureFetch(overrides: Record<string, () => Response> = {}): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = input.toString();
		urlsSeen.push(url);
		for (const [prefix, respond] of Object.entries(overrides)) {
			if (url.startsWith(prefix)) return respond();
		}
		if (url.startsWith(CONTINENTS)) {
			return new Response(JSON.stringify(continentBody(url)), { status: 200 });
		}
		if (url.startsWith(PROPERTIES)) {
			return new Response(JSON.stringify(propertiesLondon), { status: 200 });
		}
		throw new Error(`fixtureFetch: no stub configured for ${url}`);
	}) as typeof fetch;
}

function provider(fetchImpl: typeof fetch, extra: { maxCityCandidates?: number } = {}) {
	return createHostelworldStayProvider({ store: new MemoryCacheStore(), fetchImpl, ...extra });
}

const ctx = () => ({ signal: new AbortController().signal, keys: undefined });
const propertyUrls = () => urlsSeen.filter((url) => url.startsWith(PROPERTIES));

beforeEach(() => {
	urlsSeen = [];
});

describe('the keyless contract', () => {
	it('needs no key material at all, which is what makes it run for a visitor who configured nothing', () => {
		const hostelworld = provider(fixtureFetch());
		expect(hostelworld.needsKey).toBe(false);
		expect(hostelworld.keyFields).toEqual([]);
	});

	it('reports zero cost, which is what search/cost-aware.ts reads as the free tier', () => {
		expect(provider(fixtureFetch()).estimateSearchStaysCost(query)).toBe(0);
	});

	it('sends no headers, so every request stays a simple CORS request', async () => {
		// A custom header would force a preflight on the one call this app makes per search,
		// and the whole adapter moved hosts to avoid needing one. Asserted on the real
		// `RequestInit` the adapter builds.
		const inits: (RequestInit | undefined)[] = [];
		const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
			inits.push(init);
			return fixtureFetch()(input, init);
		}) as typeof fetch;

		await provider(spy).searchStays(query, ctx());
		expect(inits.length).toBe(COLD_REQUESTS);
		expect(inits.every((init) => init?.headers === undefined)).toBe(true);
	});
});

describe('searchStays', () => {
	it('prices real beds near Gatwick with no keys present', async () => {
		const result = await provider(fixtureFetch()).searchStays(query, ctx());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.length).toBeGreaterThan(0);
		expect(result.data.every((stay) => stay.pricePerNight.currency === 'EUR')).toBe(true);
		expect(result.data.every((stay) => stay.pricePerNight.minorUnits > 0)).toBe(true);
		expect(result.requestsUsed).toBe(COLD_REQUESTS);
		expect(result.source.providerId).toBe('hostelworld');
	});

	it('asks the city the airport serves first, and the walkable one as well', async () => {
		// Issue #204. Both halves matter and the second is the one that was missing.
		//
		// London first, because a three-night stopover "in London" is what the traveller
		// picked and the app should be able to price a bed there. But Hostelworld also has a
		// city called Gatwick, 2 km from the terminal, whose region is Horley — the owner
		// found rooms there himself, thirty minutes on foot, while the app showed him one
		// 39 km up the line. It was already SECOND on this list and was never asked, because
		// the loop returned as soon as London answered.
		await provider(fixtureFetch()).searchStays(query, ctx());
		const asked = propertyUrls();
		expect(asked[0]).toContain(`/cities/${LONDON_CITY_ID}/properties/`);
		expect(asked.some((url) => url.includes(`/cities/${GATWICK_CITY_ID}/properties/`))).toBe(true);
		expect(asked.some((url) => url.includes(`/cities/${CRAWLEY_CITY_ID}/properties/`))).toBe(true);
	});

	it('merges every candidate city rather than returning the first that answers', async () => {
		// The regression guard for #204 proper: a bed that exists only in the near city has
		// to reach the caller, and the near city is asked second. Under the old early return
		// this returned London's beds alone and the walkable one was unreachable.
		const nearGatwick = {
			properties: [
				{
					id: 99,
					name: 'Horley Guest House',
					latitude: 51.1668,
					longitude: -0.1668,
					lowestAveragePrivatePricePerNight: { value: '40.00', currency: 'EUR' }
				}
			]
		};
		const fetchImpl = fixtureFetch({
			[`${PROPERTIES}${GATWICK_CITY_ID}/`]: () =>
				new Response(JSON.stringify(nearGatwick), { status: 200 })
		});

		const result = await provider(fetchImpl).searchStays(query, ctx());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const names = result.data.map((stay) => stay.property.name);
		expect(names).toContain('Horley Guest House');
		// And London's are still there: this widens the answer, it does not swap one city
		// for another. Which of them wins is `search/resources.ts`'s call, not this file's.
		expect(names.some((name) => name.includes('London'))).toBe(true);
	});

	it('returns the merged beds cheapest first', async () => {
		const result = await provider(fixtureFetch()).searchStays(query, ctx());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const prices = result.data.map((stay) => stay.pricePerNight.minorUnits);
		expect(prices).toEqual([...prices].sort((a, b) => a - b));
	});

	it('asks for the nights the traveller chose, not a night count of its own', async () => {
		// Acceptance condition 4: "the nights in the stopover are a number the traveller
		// chose". Hostelworld takes a check-in and a night count where the query carries two
		// dates, so this is where that could quietly go wrong.
		await provider(fixtureFetch()).searchStays(query, ctx());
		expect(propertyUrls()[0]).toContain('date-start=2026-10-09');
		expect(propertyUrls()[0]).toContain('num-nights=3');
	});

	it('honours the search currency and party size', async () => {
		await provider(fixtureFetch()).searchStays({ ...query, currency: 'GBP', travellers: 3 }, ctx());
		expect(propertyUrls()[0]).toContain('currency=GBP');
		expect(propertyUrls()[0]).toContain('guests=3');
	});

	it('sends the two parameters the endpoint silently needs', async () => {
		// `show-rooms=0` returns a body with no properties array at all, and the default
		// ranking is not by price, so a truncated page can miss the cheapest bed entirely.
		await provider(fixtureFetch()).searchStays(query, ctx());
		expect(propertyUrls()[0]).toContain('show-rooms=1');
		expect(propertyUrls()[0]).toContain('sort=price');
	});

	it('serves a repeat search from cache and dates it honestly', async () => {
		const hostelworld = provider(fixtureFetch());
		const first = await hostelworld.searchStays(query, ctx());
		urlsSeen = [];
		const second = await hostelworld.searchStays(query, ctx());

		expect(second.ok).toBe(true);
		expect(second.requestsUsed).toBe(0);
		expect(urlsSeen).toEqual([]);
		// Issue #151: a cache hit must not claim it came off the wire this second.
		expect(second.source.fetchedAt).toBe(first.source.fetchedAt);
	});

	it('builds the city index once for concurrent stopovers, not once each', async () => {
		// `search/resources.ts` prices every candidate at the same time. Without the shared
		// in-flight promise this would be eighteen requests to learn the same geography.
		const hostelworld = provider(fixtureFetch());
		const results = await Promise.all([
			hostelworld.searchStays(query, ctx()),
			hostelworld.searchStays(query, ctx()),
			hostelworld.searchStays(query, ctx())
		]);
		expect(urlsSeen.filter((url) => url.startsWith(CONTINENTS))).toHaveLength(CONTINENT_COUNT);

		// And it charges for that build once, not three times. Reporting six requests to each
		// of three searches would print 21 against a network log showing 9.
		const reported = results.reduce((sum, result) => sum + result.requestsUsed, 0);
		expect(reported).toBe(urlsSeen.length);
	});

	it('keeps going when a candidate city has nothing within the radius', async () => {
		// A city Hostelworld knows but has sold out of for these dates is not a dead end, and
		// neither is one whose properties all sit outside the radius. Every candidate is
		// asked either way now (#204), so this asserts what survives the merge rather than
		// how many calls it took to stop.
		let propertiesCalls = 0;
		const fetchImpl = fixtureFetch({
			[PROPERTIES]: () => {
				propertiesCalls += 1;
				const body = propertiesCalls === 1 ? ELSEWHERE : propertiesLondon;
				return new Response(JSON.stringify(body), { status: 200 });
			}
		});

		const result = await provider(fetchImpl).searchStays(query, ctx());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.length).toBeGreaterThan(0);
		// Vancouver is 7,500 km from Gatwick, so the radius filter drops it — the merge is
		// not a licence to return a bed on another continent.
		expect(result.data.every((stay) => stay.property.name !== 'Wrong Continent Hostel')).toBe(true);
		expect(propertiesCalls).toBe(CITY_CANDIDATES);
	});

	it('stops after the candidate ceiling rather than pricing every city in range', async () => {
		const fetchImpl = fixtureFetch({
			[PROPERTIES]: () => new Response(JSON.stringify(ELSEWHERE), { status: 200 })
		});
		const result = await provider(fetchImpl, { maxCityCandidates: 2 }).searchStays(query, ctx());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Every candidate answered, none had a bed in range. An honest "nothing here", not an
		// error to blame Hostelworld for.
		expect(result.data).toEqual([]);
		expect(propertyUrls()).toHaveLength(2);
	});
});

describe('failures, reported as the provider stated them', () => {
	it('quotes Hostelworld own sentence out of a 400 body, with the status', async () => {
		// The real response to an unsupported currency, captured 2026-09-04. AGENTS.md:
		// "show the error you got, never the one you assumed."
		const body = {
			description: [{ code: '90593', message: 'please pass valid currency three letter code' }]
		};
		const fetchImpl = fixtureFetch({
			[PROPERTIES]: () => new Response(JSON.stringify(body), { status: 400 })
		});

		const result = await provider(fetchImpl, { maxCityCandidates: 1 }).searchStays(query, ctx());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('400');
		expect(result.error.message).toContain('please pass valid currency three letter code');
	});

	it('never reports a failure as a missing key, because there is no key to miss', async () => {
		const fetchImpl = fixtureFetch({
			[PROPERTIES]: () => new Response('Unauthorized', { status: 401 })
		});
		const result = await provider(fetchImpl, { maxCityCandidates: 1 }).searchStays(query, ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('unknown');
		expect(result.error.code).not.toBe('not-subscribed');
		expect(result.error.message).toContain('401');
	});

	it('treats a 429 as back off and try later', async () => {
		const fetchImpl = fixtureFetch({
			[PROPERTIES]: () => new Response('', { status: 429, headers: { 'retry-after': '30' } })
		});
		const result = await provider(fetchImpl, { maxCityCandidates: 1 }).searchStays(query, ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('quota-exceeded');
		expect(result.error).toMatchObject({ retryAfterSeconds: 30 });
	});

	it('resolves rather than rejecting when the response is not JSON', async () => {
		// One provider failing must never fail a search, so this resolves an error envelope.
		const fetchImpl = fixtureFetch({
			[PROPERTIES]: () => new Response('<html>maintenance</html>', { status: 200 })
		});
		const result = await provider(fetchImpl, { maxCityCandidates: 1 }).searchStays(query, ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed-response');
	});

	it('reports the geography failing rather than pretending there are no hostels', async () => {
		const fetchImpl = fixtureFetch({
			[CONTINENTS]: () => new Response('', { status: 503 })
		});
		const result = await provider(fetchImpl).searchStays(query, ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('503');
		expect(propertyUrls()).toEqual([]);
	});

	it('carries on when one continent fails and the airport is on another', async () => {
		// Five sixths of the world is still enough geography to find a bed in the sixth.
		const fetchImpl = fixtureFetch({
			[`${CONTINENTS}1/`]: () => new Response('', { status: 500 })
		});
		const result = await provider(fetchImpl).searchStays(query, ctx());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.length).toBeGreaterThan(0);
	});

	it('resolves a cancelled result rather than letting an AbortError escape', async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await provider(fixtureFetch()).searchStays(query, {
			signal: controller.signal,
			keys: undefined
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('cancelled');
		expect(urlsSeen).toEqual([]);
	});

	it('spends nothing on a query with no nights in it', async () => {
		const result = await provider(fixtureFetch()).searchStays(
			{ ...query, checkOut: query.checkIn },
			ctx()
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual([]);
		expect(result.requestsUsed).toBe(0);
		expect(urlsSeen).toEqual([]);
	});

	it('finds nothing, honestly, for a coordinate with no Hostelworld city near it', async () => {
		// Mid-Atlantic. The index still loads; nothing in it is within the radius.
		const result = await provider(fixtureFetch()).searchStays(
			{ ...query, near: { latitude: 30, longitude: -40 } },
			ctx()
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual([]);
		expect(propertyUrls()).toEqual([]);
	});
});

describe('healthCheck', () => {
	it('asks a real question rather than pinging', async () => {
		const result = await provider(fixtureFetch()).healthCheck(ctx());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.message).toContain('European cities');
		expect(result.requestsUsed).toBe(1);
	});

	it('fails when Hostelworld answers with no geography', async () => {
		const fetchImpl = fixtureFetch({
			[CONTINENTS]: () => new Response('{"countries":[]}', { status: 200 })
		});
		const result = await provider(fetchImpl).healthCheck(ctx());
		expect(result.ok).toBe(false);
	});
});
