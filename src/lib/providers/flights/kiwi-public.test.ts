/**
 * Exercises the adapter end to end — request building, cache, mapping and error handling
 * — with a fake `fetch` that resolves the captured fixtures, so nothing here touches the
 * network. The live measurements these fixtures came from are in docs/PROVIDERS.md and in
 * the PR description.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../../cache';
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
