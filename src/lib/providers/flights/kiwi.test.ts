import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import { clearInFlightForTests, clearProviderQuotaStateForTests, resetPermanentFailuresForTests } from '../budget';
import oneWayFixture from './fixtures/kiwi-one-way-bcn-otp.json';
import { createKiwiFlightProvider, KIWI_UNVERIFIED_AGAINST_LIVE_RESPONSE } from './kiwi';

/**
 * Exercises the adapter end to end — cache, mapping and error handling together — with a
 * fake `fetch` that resolves fixtures, mirroring ryanair.test.ts. This adapter's own
 * live-network attempt (after a real $0 BASIC-plan subscription) is documented in the PR
 * and in docs/PROVIDERS.md rather than run here: it returned 402/DEPLOYMENT_DISABLED, so a
 * suite that must pass the same way in CI as it did while writing this adapter cannot
 * depend on that backend coming back.
 *
 * Issue #69: this adapter now routes every real request through `callProviderWithBudget`
 * (../budget), which keeps module-level state (in-flight dedup, the permanently-
 * unsubscribed set, and a `localStorage`-backed monthly counter) that must be reset between
 * tests, same as flights-sky.test.ts does — otherwise one test's "not-subscribed" or quota
 * spend leaks into the next.
 */
const instantSleep = async () => {};

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
	localStorage.clear();
	clearInFlightForTests();
	resetPermanentFailuresForTests();
	clearProviderQuotaStateForTests();
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

	it('maps a 403 to not-subscribed without throwing', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () =>
				new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'not-subscribed', status: 403 } });
	});

	it('remembers not-subscribed for the provider and stops calling the network on a later search', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () =>
				new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		const callsAfterFirst = fetchCallCount;
		const second = await provider.searchOffers(query, { signal: new AbortController().signal, keys });

		expect(second).toMatchObject({ ok: false, requestsUsed: 0, error: { code: 'not-subscribed' } });
		// Issue #69: tracked per `ProviderId` by the shared budget module
		// (../budget/permanent-failures.ts) now, not per API key the way this adapter used
		// to hand-roll it — one consistent rule across every adapter wired to the module.
		expect(fetchCallCount).toBe(callsAfterFirst); // no new network call for the remembered provider
	});

	it('maps a 429 to quota-exceeded without throwing', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () => new Response(null, { status: 429 })
		});
		// cap: 1 lets the single attempt through and refuses `callProviderWithBudget`'s own
		// retry before it fires a second real fetch — a hard stop, not a guess at how many
		// attempts its default backoff would otherwise make.
		const provider = createKiwiFlightProvider({
			store: new MemoryCacheStore(),
			fetchImpl,
			cap: 1,
			sleep: instantSleep
		});

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

	it('maps a network failure to a typed error without throwing', async () => {
		const fetchImpl = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		// `callProviderWithBudget` (../budget) retries a network error with backoff before
		// giving up — `sleep: instantSleep` keeps that fast rather than actually waiting.
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl, sleep: instantSleep });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'network-error' } });
	});

	it('reports a cost of 1, unconditionally: this is a native date-range endpoint', () => {
		const provider = createKiwiFlightProvider();
		expect(provider.estimateSearchOffersCost(query)).toBe(1);
	});

	it('maps a well-formed HTTP 200 with a shape this adapter cannot read to malformed-response, not to wrong offers', async () => {
		// A segment missing every field mapSegmentToFlightOffer reads — the failure mode
		// this adapter is most exposed to, since its shape was never confirmed live
		// (kiwi-mapper.ts's header). Producing an offer from this would be a fabricated
		// price, not a dropped one.
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () =>
				new Response(JSON.stringify({ currency: 'eur', data: [{ deep_link: 'x', route: [{}] }] }), {
					status: 200
				})
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		// A genuine HTTP response was received and billed, even though this app's own
		// parsing rejected the body — costOf's reasoning, unaffected by shape validation.
		expect(result).toMatchObject({ ok: false, error: { code: 'malformed-response' }, requestsUsed: 1 });
	});

	it('rejects the whole response when only one field on one segment is wrong, rather than a partial result', async () => {
		const badFixture = {
			currency: 'eur',
			data: [
				oneWayFixture.data[0], // otherwise-valid nonstop itinerary
				{ deep_link: 'y', route: [{ ...oneWayFixture.data[1].route[0], dTime: 'not-a-number' }] }
			]
		};
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () => new Response(JSON.stringify(badFixture), { status: 200 })
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'malformed-response' } });
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

	it('maps a badly-shaped HTTP 200 to malformed-response rather than an empty or wrong destination list', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () =>
				new Response(JSON.stringify({ currency: 'eur', data: [{ route: 'not-an-array' }] }), { status: 200 })
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.listDirectDestinations('BCN', { signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'malformed-response' }, requestsUsed: 1 });
	});
});

describe('healthCheck', () => {
	it('fails closed on a well-shaped 200, since this adapter is unverified against a live response', async () => {
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.healthCheck({ signal: new AbortController().signal, keys });

		// Still spends (and reports) the real request Kiwi actually billed — failing
		// closed here is a policy decision about trust, not a claim that no call happened.
		expect(result).toMatchObject({ ok: false, error: { code: 'unknown' }, requestsUsed: 1 });
		if (result.ok) return;
		expect(result.error.message).toMatch(/unverified against a live response/i);
		expect(result.error.message).toMatch(/matched this adapter's current \(unverified\) assumptions/i);
	});

	it('notes a shape mismatch in the message when the 200 body does not even match this adapter\'s guess', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () =>
				new Response(JSON.stringify({ currency: 'eur', data: [{ route: [{ flyFrom: 'LHR' }] }] }), {
					status: 200
				})
		});
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl });
		const result = await provider.healthCheck({ signal: new AbortController().signal, keys });

		expect(result).toMatchObject({ ok: false, error: { code: 'unknown' }, requestsUsed: 1 });
		if (result.ok) return;
		expect(result.error.message).toMatch(/did NOT match this adapter's assumptions/);
	});

	it('still surfaces the real error untouched when the live call itself fails, unaffected by being unverified', async () => {
		const fetchImpl = fixtureFetch({
			'https://kiwi-com-cheap-flights.p.rapidapi.com': () => new Response(null, { status: 429 })
		});
		const provider = createKiwiFlightProvider({
			store: new MemoryCacheStore(),
			fetchImpl,
			cap: 1,
			sleep: instantSleep
		});
		const result = await provider.healthCheck({ signal: new AbortController().signal, keys });
		expect(result).toMatchObject({ ok: false, error: { code: 'quota-exceeded', status: 429 } });
	});

	it('never throws when Kiwi is unreachable', async () => {
		const fetchImpl = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		const provider = createKiwiFlightProvider({ store: new MemoryCacheStore(), fetchImpl, sleep: instantSleep });
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

	it('exposes unverifiedAgainstLiveResponse structurally, not just in a comment', () => {
		const provider = createKiwiFlightProvider();
		expect(provider.unverifiedAgainstLiveResponse).toBe(true);
		expect(provider.unverifiedAgainstLiveResponse).toBe(KIWI_UNVERIFIED_AGAINST_LIVE_RESPONSE);
	});
});
