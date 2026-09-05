/**
 * Exercises the adapter end to end — request building, cache, mapping and error handling
 * — with a fake `fetch` that resolves the captured fixtures, so nothing here touches the
 * network. The live measurements these fixtures came from are in docs/PROVIDERS.md and in
 * the PR description.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore, defineCacheKey } from '../../cache';
import type { CacheKey } from '../../cache';
import type { IataAirportCode } from '../../domain';
import bvcToLgw from './fixtures/kiwi-public-oneway-bvc-lgw.json';
import onePerCityBvc from './fixtures/kiwi-public-oneper-city-bvc.json';
import { createKiwiPublicFlightProvider } from './kiwi-public';

const ENDPOINT = 'https://api.skypicker.com/umbrella/v2/graphql';

interface CapturedRequest {
	url: string;
	body: { query: string; variables: Record<string, unknown> };
}

let requests: CapturedRequest[] = [];

/** Answers whichever of the two queries was asked for, keyed off `?featureName=`, and
 * records the request so a test can assert on what was actually sent. */
function fixtureFetch(respond?: (url: string) => Response): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input.toString();
		requests.push({ url, body: JSON.parse(String(init?.body)) });
		if (respond) return respond(url);
		if (url.includes('featureName=SearchOneWayItinerariesQuery')) {
			return new Response(JSON.stringify(bvcToLgw), { status: 200 });
		}
		if (url.includes('featureName=OnePerCityItinerariesQuery')) {
			return new Response(JSON.stringify(onePerCityBvc), { status: 200 });
		}
		// Issue #340's route check reuses the one-way document under its own feature name, so
		// the BVC to LGW capture is the right answer to it too.
		if (url.includes('featureName=DirectRouteCheckQuery')) {
			return new Response(JSON.stringify(bvcToLgw), { status: 200 });
		}
		throw new Error(`fixtureFetch: no stub configured for ${url}`);
	}) as typeof fetch;
}

function makeProvider(fetchImpl: typeof fetch, store = new MemoryCacheStore()) {
	return createKiwiPublicFlightProvider({
		store,
		fetchImpl,
		// Frozen so the derived route-lookup window, and therefore its cache key, is the
		// same on every run instead of moving with the calendar.
		now: () => Date.parse('2026-09-04T00:00:00Z')
	});
}

const query = {
	origin: 'BVC',
	destination: 'LGW',
	earliestDeparture: '2026-10-06',
	latestDeparture: '2026-10-08'
};

const ctx = () => ({ signal: new AbortController().signal });

beforeEach(() => {
	requests = [];
});

describe('provider identity', () => {
	it('needs no key, which is what makes it usable on a first visit', () => {
		const provider = makeProvider(fixtureFetch());
		expect(provider.needsKey).toBe(false);
		expect(provider.keyFields).toEqual([]);
		expect(provider.id).toBe('kiwi-public');
	});

	it('reports zero cost, which is how connections.ts classifies it as a free source', () => {
		// Not cosmetic: a provider classified as metered is only ever used as a last resort
		// for candidates the caller allow-listed, which is never during broad discovery.
		expect(makeProvider(fixtureFetch()).estimateSearchOffersCost(query)).toBe(0);
	});
});

describe('searchOffers', () => {
	it('returns the real BVC to LGW offer on a cold cache, for one request', async () => {
		const provider = makeProvider(fixtureFetch());
		const result = await provider.searchOffers(query, ctx());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(1);
		expect(result.data[0]).toMatchObject({
			flightNumber: 'BY259',
			departureAirport: 'BVC',
			arrivalAirport: 'LGW',
			price: { minorUnits: 17300, currency: 'EUR' },
			priceScope: 'per-person'
		});
		expect(result.source.providerId).toBe('kiwi-public');
		// One request covers the whole date range, unlike Sky Scrapper's one-per-day shape.
		expect(result.requestsUsed).toBe(1);
	});

	it('spends one request for a three-day window, not one per day', async () => {
		const provider = makeProvider(fixtureFetch());
		await provider.searchOffers(query, ctx());

		expect(requests).toHaveLength(1);
		expect(requests[0].body.variables.search).toMatchObject({
			itinerary: {
				outboundDepartureDate: { start: '2026-10-06T00:00:00', end: '2026-10-08T23:59:59' }
			}
		});
	});

	it('serves an identical second call from cache, spending nothing', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		await makeProvider(fetchImpl, store).searchOffers(query, ctx());
		const second = await makeProvider(fetchImpl, store).searchOffers(query, ctx());

		expect(requests).toHaveLength(1);
		expect(second.ok && second.requestsUsed).toBe(0);
	});

	it('reuses the cached answer when only the traveller count changed', async () => {
		// This adapter always prices one adult, so a party of four is the same request. A
		// cache key built from the whole query would re-fetch every leg for an answer
		// already on disk.
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		await makeProvider(fetchImpl, store).searchOffers({ ...query, travellers: 1 }, ctx());
		const second = await makeProvider(fetchImpl, store).searchOffers(
			{ ...query, travellers: 4 },
			ctx()
		);

		expect(requests).toHaveLength(1);
		expect(second.ok && second.data).toHaveLength(1);
	});

	it('does not serve a different currency from the cached one', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		await makeProvider(fetchImpl, store).searchOffers(query, ctx());
		await makeProvider(fetchImpl, store).searchOffers({ ...query, currency: 'GBP' }, ctx());

		expect(requests).toHaveLength(2);
		expect(requests[1].body.variables.options).toMatchObject({ currency: 'gbp' });
	});

	it('returns an empty ok result, not an error, when the caller has no budget left', async () => {
		const provider = makeProvider(fixtureFetch());
		const result = await provider.searchOffers(query, { ...ctx(), maxRequests: 0 });

		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
		expect(requests).toHaveLength(0);
	});

	it('reports a cancelled search without touching the network', async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await makeProvider(fixtureFetch()).searchOffers(query, {
			signal: controller.signal
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('cancelled');
		expect(requests).toHaveLength(0);
	});

	it("surfaces Kiwi's own AppError message verbatim", async () => {
		const provider = makeProvider(
			fixtureFetch(
				() =>
					new Response(
						JSON.stringify({
							data: { onewayItineraries: { __typename: 'AppError', error: 'Search unavailable' } }
						}),
						{ status: 200 }
					)
			)
		);
		const result = await provider.searchOffers(query, ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		// AGENTS.md: show the error you got, never the one you assumed.
		expect(result.error.message).toContain('Search unavailable');
	});

	it('classifies a 429 as quota-exceeded and keeps the Retry-After', async () => {
		const provider = makeProvider(
			fixtureFetch(
				() => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
			)
		);
		const result = await provider.searchOffers(query, ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({ code: 'quota-exceeded', retryAfterSeconds: 30 });
	});

	it('reports the real status code for an unexpected HTTP failure', async () => {
		// 403 is the shape Kiwi's bot wall returns, so a reader must be able to tell it
		// apart from a network outage.
		const provider = makeProvider(fixtureFetch(() => new Response('nope', { status: 403 })));
		const result = await provider.searchOffers(query, ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('403');
	});

	it('reports a GraphQL-level error as malformed rather than as no results', async () => {
		const provider = makeProvider(
			fixtureFetch(
				() =>
					new Response(JSON.stringify({ errors: [{ message: 'Unknown field "timezone"' }] }), {
						status: 200
					})
			)
		);
		const result = await provider.searchOffers(query, ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed-response');
		expect(result.error.message).toContain('Unknown field "timezone"');
	});

	it('reports a failed fetch as a network error rather than throwing', async () => {
		const provider = makeProvider((async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch);
		const result = await provider.searchOffers(query, ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('network-error');
	});
});

describe('listDirectDestinations', () => {
	it('answers for an airport no other adapter in this app can answer for', async () => {
		const provider = makeProvider(fixtureFetch());
		const result = await provider.listDirectDestinations('BVC', ctx());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Ryanair 404s BVC; Sky Scrapper and Flights Sky both return a failure for this
		// method by design. Without this, the connection graph has no candidate to rank.
		expect(result.data).toContain('LGW');
		expect(result.requestsUsed).toBe(1);
	});

	it('asks about a future window rather than dates that are already sold out', async () => {
		const provider = makeProvider(fixtureFetch());
		await provider.listDirectDestinations('BVC', ctx());

		const search = requests[0].body.variables.search as {
			itinerary: { outboundDepartureDate: { start: string; end: string } };
		};
		expect(search.itinerary.outboundDepartureDate.start).toBe('2026-09-18T00:00:00');
		expect(search.itinerary.outboundDepartureDate.end).toBe('2026-10-18T23:59:59');
	});

	it('caches the route list so repeated candidate checks cost nothing', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		await makeProvider(fetchImpl, store).listDirectDestinations('BVC', ctx());
		const second = await makeProvider(fetchImpl, store).listDirectDestinations('BVC', ctx());

		expect(requests).toHaveLength(1);
		expect(second.ok && second.requestsUsed).toBe(0);
	});

	it('stops looking routes up past its ceiling instead of hammering an unofficial endpoint', async () => {
		// A real BCN->OTP search asked this adapter for 120 route lookups before the ceiling
		// existed — the same shape issue #121 measured for Ryanair and #145 fixed. Kiwi has
		// no whole-network endpoint to fix it the same way, so it stops instead.
		const provider = createKiwiPublicFlightProvider({
			store: new MemoryCacheStore(),
			fetchImpl: fixtureFetch(),
			now: () => Date.parse('2026-09-04T00:00:00Z'),
			maxRouteLookups: 2
		});

		const first = await provider.listDirectDestinations('BVC', ctx());
		const second = await provider.listDirectDestinations('LIS', ctx());
		const third = await provider.listDirectDestinations('OPO', ctx());

		expect(first.ok && first.data.length).toBeGreaterThan(0);
		expect(second.ok && second.data.length).toBeGreaterThan(0);
		// Past the ceiling: an empty ok, which connections.ts reads as "this source doesn't
		// know" and falls through — never a failure, because it did not fail.
		expect(third).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
		expect(requests).toHaveLength(2);
	});

	it('ships a default ceiling of 20, not one that costs a whole page load (#165)', async () => {
		// The shipped constant, not an injected one. It was 40, and a measured BCN to TLL
		// search spent all 40 on one page load and another 40 on the reload, because the
		// counter resets with the page while the candidate order does not. Asserting the
		// real default is what stops that number drifting back up unnoticed.
		const provider = createKiwiPublicFlightProvider({
			store: new MemoryCacheStore(),
			fetchImpl: fixtureFetch(),
			now: () => Date.parse('2026-09-04T00:00:00Z')
		});

		// 25 distinct airports, so the ceiling is crossed by a margin no off-by-one hides.
		const codes = Array.from({ length: 25 }, (_, i) => `X${String(i).padStart(2, '0')}`);
		for (const code of codes) await provider.listDirectDestinations(code as IataAirportCode, ctx());

		expect(requests).toHaveLength(20);
	});

	it('does not spend the ceiling on airports it can answer from cache', async () => {
		const provider = createKiwiPublicFlightProvider({
			store: new MemoryCacheStore(),
			fetchImpl: fixtureFetch(),
			now: () => Date.parse('2026-09-04T00:00:00Z'),
			maxRouteLookups: 1
		});

		await provider.listDirectDestinations('BVC', ctx());
		const cached = await provider.listDirectDestinations('BVC', ctx());

		// A repeated search over the same airports must stay free, not eat the ceiling and
		// then start answering "I don't know" about airports it already knows.
		expect(cached.ok && cached.data.length).toBeGreaterThan(0);
		expect(requests).toHaveLength(1);
	});

	it('caches an empty answer, so a dead-end origin is not re-asked every search', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch(
			() =>
				new Response(
					JSON.stringify({
						data: {
							onewayOnePerCityItineraries: {
								__typename: 'OnePerCityItineraries',
								itineraries: []
							}
						}
					}),
					{ status: 200 }
				)
		);
		const first = await makeProvider(fetchImpl, store).listDirectDestinations('ZZZ', ctx());
		const second = await makeProvider(fetchImpl, store).listDirectDestinations('ZZZ', ctx());

		expect(first).toMatchObject({ ok: true, data: [] });
		expect(second).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
		expect(requests).toHaveLength(1);
	});
});

describe('healthCheck', () => {
	it('passes when Kiwi lists real destinations', async () => {
		const provider = makeProvider(fixtureFetch());
		const result = await provider.healthCheck(ctx());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.message).toMatch(/direct destinations/);
	});

	it('fails when Kiwi answers with nothing at all for a major hub', async () => {
		// An empty answer for London Gatwick means something changed at Kiwi's end, not
		// that Gatwick stopped flying anywhere.
		const provider = makeProvider(
			fixtureFetch(
				() =>
					new Response(
						JSON.stringify({
							data: {
								onewayOnePerCityItineraries: {
									__typename: 'OnePerCityItineraries',
									itineraries: []
								}
							}
						}),
						{ status: 200 }
					)
			)
		);
		const result = await provider.healthCheck(ctx());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed-response');
	});

	it('bypasses the cache, since a stale yes does not answer "is it up now"', async () => {
		const store = new MemoryCacheStore();
		const fetchImpl = fixtureFetch();
		await makeProvider(fetchImpl, store).healthCheck(ctx());
		await makeProvider(fetchImpl, store).healthCheck(ctx());

		expect(requests).toHaveLength(2);
	});
});

describe('request shape', () => {
	it('posts JSON to the umbrella endpoint with a truthful featureName', async () => {
		await makeProvider(fixtureFetch()).searchOffers(query, ctx());

		expect(requests[0].url).toBe(`${ENDPOINT}?featureName=SearchOneWayItinerariesQuery`);
		expect(requests[0].body.query).toContain('onewayItineraries');
	});

	it('sends no key, header or cookie of any kind', async () => {
		// The whole point of this provider. If it ever needs credentials, it stops being the
		// thing that works on a first visit.
		let seenInit: RequestInit | undefined;
		const provider = makeProvider((async (_input: RequestInfo | URL, init?: RequestInit) => {
			seenInit = init;
			return new Response(JSON.stringify(bvcToLgw), { status: 200 });
		}) as typeof fetch);
		await provider.searchOffers(query, ctx());

		expect(seenInit?.headers).toEqual({ 'content-type': 'application/json' });
		expect(seenInit?.credentials).toBeUndefined();
	});
});

/**
 * Issue #151. This adapter landed the same day the sweep did, carrying the same bug the
 * other eight had: `source()` stamped `new Date()` on a cache hit, so a fifteen-minute-old
 * fare claimed on screen to have just come off Kiwi's wire.
 */
describe('how old a cached answer says it is', () => {
	/**
	 * Warms the cache through the adapter itself, then rewinds every entry it wrote by
	 * `ms`. Recording the keys the adapter really used beats rebuilding them here: a
	 * hardcoded key would quietly start testing a cache miss the day a key's shape changes,
	 * and this file's own comments show that shape has changed before.
	 */
	async function ageEntriesWrittenBy(
		store: MemoryCacheStore,
		ms: number,
		seed: () => Promise<unknown>
	): Promise<number[]> {
		const written: string[] = [];
		const realSet = store.set.bind(store);
		store.set = async (entry) => {
			written.push(entry.key);
			return realSet(entry);
		};
		await seed();
		store.set = realSet;

		const storedAts: number[] = [];
		for (const key of written) {
			const entry = await store.get(key);
			if (entry === undefined) continue;
			const storedAt = entry.storedAt - ms;
			await realSet({ ...entry, storedAt });
			storedAts.push(storedAt);
		}
		return storedAts;
	}

	it('dates a cached fare by when Kiwi really answered, not by when the cache was read', async () => {
		const store = new MemoryCacheStore();
		const provider = makeProvider(fixtureFetch(), store);
		const [storedAt] = await ageEntriesWrittenBy(store, 10 * 60_000, () =>
			provider.searchOffers(query, ctx())
		);

		const second = await provider.searchOffers(query, ctx());

		expect(second.requestsUsed).toBe(0);
		// ResultCard renders this as "via Kiwi · fetched 10 minutes ago".
		expect(second.source.fetchedAt).toBe(new Date(storedAt).toISOString());
	});

	it('dates a cached route list the same way', async () => {
		const store = new MemoryCacheStore();
		const provider = makeProvider(fixtureFetch(), store);
		const [storedAt] = await ageEntriesWrittenBy(store, 45 * 60_000, () =>
			provider.listDirectDestinations('BVC', ctx())
		);

		const second = await provider.listDirectDestinations('BVC', ctx());

		expect(second.requestsUsed).toBe(0);
		expect(second.source.fetchedAt).toBe(new Date(storedAt).toISOString());
	});

	it('still stamps a freshly fetched answer with now', async () => {
		const before = Date.now();
		const result = await makeProvider(fixtureFetch()).searchOffers(query, ctx());
		expect(new Date(result.source.fetchedAt).getTime()).toBeGreaterThanOrEqual(before);
	});
});

describe('expired entries are served, not discarded (#165)', () => {
	/** Rewrites an entry's `storedAt` so it is past its TTL without waiting out a real TTL. */
	async function ageEntry(store: MemoryCacheStore, key: CacheKey, ageMs: number): Promise<void> {
		const entry = await store.get(key.raw);
		if (!entry) throw new Error(`nothing cached under ${key.raw}`);
		await store.set({ ...entry, storedAt: Date.now() - ageMs, lastAccessedAt: Date.now() });
	}

	const offersKey = () =>
		defineCacheKey(
			'kiwi-public',
			{
				op: 'searchOffers',
				origin: query.origin,
				destination: query.destination,
				earliestDeparture: query.earliestDeparture,
				latestDeparture: query.latestDeparture,
				currency: 'EUR'
			},
			15 * 60_000
		);

	// The window `listDirectDestinations` derives from the frozen `now` above: 14 days out,
	// 30 days long.
	const destinationsKey = () =>
		defineCacheKey(
			'kiwi-public',
			{
				op: 'listDirectDestinations',
				origin: 'BVC',
				earliestDeparture: '2026-09-18',
				latestDeparture: '2026-10-18'
			},
			24 * 60 * 60_000
		);

	it('answers a reload from an expired fare entry instead of going back to the network', async () => {
		// This is the regression: #155 took a reload from 48 requests to 0 by serving an
		// expired fare and refreshing behind it. Discarding on expiry here put the wait back
		// for every page holding a Kiwi result, because the candidate graph waits on Kiwi.
		const store = new MemoryCacheStore();
		await makeProvider(fixtureFetch(), store).searchOffers(query, ctx());
		await ageEntry(store, offersKey(), 2 * 60 * 60_000);
		requests = [];

		const provider = makeProvider(fixtureFetch(), store);
		const result = await provider.searchOffers(query, ctx());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The answer is already there. The refresh is behind it, not in front of it.
		expect(result.data).toHaveLength(1);
	});

	it('says how old an expired fare really is, rather than claiming it just arrived', async () => {
		const store = new MemoryCacheStore();
		await makeProvider(fixtureFetch(), store).searchOffers(query, ctx());
		const twoHours = 2 * 60 * 60_000;
		await ageEntry(store, offersKey(), twoHours);

		const result = await makeProvider(fixtureFetch(), store).searchOffers(query, ctx());

		// ResultCard renders this as "fetched 2 hours ago". Stamping `new Date()` here would
		// make it say "just now" about a two-hour-old price.
		const age = Date.now() - Date.parse(result.source.fetchedAt);
		expect(age).toBeGreaterThanOrEqual(twoHours - 5_000);
	});

	it('refreshes the expired fare behind the answer, so the entry does not stay stale forever', async () => {
		const store = new MemoryCacheStore();
		await makeProvider(fixtureFetch(), store).searchOffers(query, ctx());
		await ageEntry(store, offersKey(), 2 * 60 * 60_000);
		requests = [];

		const provider = makeProvider(fixtureFetch(), store);
		const result = await provider.searchOffers(query, ctx());
		// The revalidation is deliberately not awaited by the caller, so wait for the task
		// queue rather than for the answer.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(requests).toHaveLength(1);
		// Counted against the caller's budget even though the caller did not wait for it.
		expect(result.requestsUsed).toBe(1);
		const refreshed = await store.get(offersKey().raw);
		expect(Date.now() - (refreshed?.storedAt ?? 0)).toBeLessThan(5_000);
	});

	it('serves an expired route graph without waiting for the network', async () => {
		const store = new MemoryCacheStore();
		await makeProvider(fixtureFetch(), store).listDirectDestinations('BVC', ctx());
		const before = (await store.get(destinationsKey().raw))?.value as string[];
		await ageEntry(store, destinationsKey(), 48 * 60 * 60_000);

		// A fetch that never settles. If this call waited on the refresh rather than
		// answering from the expired entry, the test hangs instead of failing an assertion
		// — which is exactly the user-visible symptom: a page that paints nothing.
		const hangingFetch = (() => new Promise<Response>(() => {})) as typeof fetch;
		const result = await makeProvider(hangingFetch, store).listDirectDestinations('BVC', ctx());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual(before);
	});

	it('does not overwrite a real route graph with an empty one when the refresh fails', async () => {
		// Losing the route graph is losing every candidate stopover, which is the search.
		const store = new MemoryCacheStore();
		await makeProvider(fixtureFetch(), store).listDirectDestinations('BVC', ctx());
		const before = (await store.get(destinationsKey().raw))?.value as string[];
		await ageEntry(store, destinationsKey(), 48 * 60 * 60_000);

		const failing = makeProvider(
			fixtureFetch(() => new Response('nope', { status: 503 })),
			store
		);
		await failing.listDirectDestinations('BVC', ctx());
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect((await store.get(destinationsKey().raw))?.value).toEqual(before);
	});
	describe('hasDirectRoute (issue #340)', () => {
		it('asks about the one pair, under its own feature name, instead of listing everywhere', async () => {
			const result = await makeProvider(fixtureFetch()).hasDirectRoute!('BVC', 'LGW', ctx());

			expect(result).toMatchObject({ ok: true, data: true, requestsUsed: 1 });
			expect(requests).toHaveLength(1);
			// The feature name is what `route-graph-fanout.qa.ts` counts these by, and what
			// keeps a route check out of Kiwi's own fare-search logs.
			expect(requests[0].url).toContain('featureName=DirectRouteCheckQuery');
			const itinerary = requests[0].body.variables.search as { itinerary: Record<string, unknown> };
			expect(itinerary.itinerary.destination).toEqual({ ids: ['Station:airport:LGW'] });
		});

		it('judges the answer with the offer mapper, not by counting rows', async () => {
			// A row Kiwi returns is not automatically a flight this app can offer: the mapper
			// is what rejects a self-transfer or a chain of two flight numbers. Confirming a
			// route from a row the fare stage would then refuse produces a candidate that can
			// never become an itinerary, and #332 would report it as "no onward flight" while
			// this adapter had said there was one.
			const empty = { data: { onewayItineraries: { __typename: 'Itineraries', itineraries: [] } } };
			const result = await makeProvider(
				fixtureFetch(() => new Response(JSON.stringify(empty), { status: 200 }))
			).hasDirectRoute!('BVC', 'PFO', ctx());

			expect(result).toMatchObject({ ok: true, data: false });
		});

		it('says it does not know, rather than no, once the session ceiling is reached', async () => {
			// The one place a `false` from here is not "I looked and found nothing", so it is
			// worth pinning that it costs no request and reports none.
			const provider = createKiwiPublicFlightProvider({
				store: new MemoryCacheStore(),
				fetchImpl: fixtureFetch(),
				now: () => Date.parse('2026-09-04T00:00:00Z'),
				maxRouteLookups: 0
			});

			const result = await provider.hasDirectRoute!('BVC', 'LGW', ctx());

			expect(result).toMatchObject({ ok: true, data: false, requestsUsed: 0 });
			expect(requests).toHaveLength(0);
		});

		it('serves a cached answer without a second request', async () => {
			const store = new MemoryCacheStore();
			const fetchImpl = fixtureFetch();
			await makeProvider(fetchImpl, store).hasDirectRoute!('BVC', 'LGW', ctx());
			const second = await makeProvider(fetchImpl, store).hasDirectRoute!('BVC', 'LGW', ctx());

			expect(second).toMatchObject({ ok: true, data: true, requestsUsed: 0 });
			expect(requests).toHaveLength(1);
		});

		it('serves a cached NO without a second request', async () => {
			// The one that shipped broken. `CachedEntry.fresh` is `T | undefined`, so the
			// `!cached.fresh` every other read here uses reports a fresh `false` as expired,
			// and "no route" is the common answer on this path. A reload then re-asked every
			// candidate that had come back negative — twelve lookups on the acceptance route,
			// caught by `route-graph-fanout.qa.ts`'s reload check and by nothing else.
			const empty = { data: { onewayItineraries: { __typename: 'Itineraries', itineraries: [] } } };
			const store = new MemoryCacheStore();
			const fetchImpl = fixtureFetch(() => new Response(JSON.stringify(empty), { status: 200 }));
			await makeProvider(fetchImpl, store).hasDirectRoute!('BVC', 'PFO', ctx());
			const second = await makeProvider(fetchImpl, store).hasDirectRoute!('BVC', 'PFO', ctx());

			expect(second).toMatchObject({ ok: true, data: false, requestsUsed: 0 });
			expect(requests).toHaveLength(1);
		});
	});
});
