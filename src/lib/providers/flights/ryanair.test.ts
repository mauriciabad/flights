import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore, onRevalidationSettled } from '../../cache';
import activeAirportsFixture from './fixtures/active-airports.json';
import cheapestPerDayFixture from './fixtures/cheapest-per-day-bcn-stn.json';
import scheduleFixture from './fixtures/schedule-bcn-stn.json';
import { createRyanairFlightProvider, monthsSpanned, MAX_FARE_MONTHS_PER_SEARCH } from './ryanair';

/**
 * Exercises the adapter end to end — cache, the two-endpoint fare join, and error handling
 * together — with a fake `fetch` that resolves fixtures keyed by URL, so nothing here
 * touches the network.
 * A real network round trip against the live Ryanair endpoints is done by hand, once,
 * during development; see the PR description for that result, since a live call has no
 * place in a suite that must run the same way in CI as on a disconnected laptop.
 */

let fetchCallCount = 0;
let requestedUrls: string[] = [];

function fixtureFetch(overrides: Record<string, () => Response> = {}): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		fetchCallCount++;
		const url = input.toString();
		requestedUrls.push(url);
		for (const [prefix, respond] of Object.entries(overrides)) {
			if (url.startsWith(prefix)) return respond();
		}
		if (url.includes('/cheapestPerDay')) {
			return new Response(JSON.stringify(cheapestPerDayFixture), { status: 200 });
		}
		if (url.startsWith('https://services-api.ryanair.com/timtbl/3/schedules/')) {
			return new Response(JSON.stringify(scheduleFixture), { status: 200 });
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
	requestedUrls = [];
});

describe('monthsSpanned', () => {
	it('returns the single month a normal search window sits inside', () => {
		expect(monthsSpanned('2026-10-01', '2026-10-25')).toEqual([
			{ year: 2026, month: 10, monthStart: '2026-10-01' }
		]);
	});

	it('returns every month a window straddles, including across a year boundary', () => {
		expect(monthsSpanned('2026-12-20', '2027-01-05').map((m) => m.monthStart)).toEqual([
			'2026-12-01',
			'2027-01-01'
		]);
	});

	// A departure window wider than a quarter is not a trip search, and each month is a
	// pair of requests against Ryanair's own rate limiter (issue #121).
	it('stops at the request ceiling instead of fanning out over a silly range', () => {
		expect(monthsSpanned('2026-01-01', '2030-12-31')).toHaveLength(MAX_FARE_MONTHS_PER_SEARCH);
	});

	it('returns nothing for a reversed or unparsable range rather than looping', () => {
		expect(monthsSpanned('2026-10-25', '2026-10-01')).toHaveLength(1); // same month, still one
		expect(monthsSpanned('2026-11-01', '2026-10-01')).toEqual([]);
		expect(monthsSpanned('not-a-date', '2026-10-01')).toEqual([]);
		expect(monthsSpanned('2026-13-01', '2026-13-05')).toEqual([]);
	});
});

describe('searchOffers', () => {
	it('returns one offer per sellable day, not the single fare the old endpoint gave', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(query, { signal: new AbortController().signal });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Six days in the captured fixture, all inside the queried window — where the
		// fare-finder endpoint this replaced returned exactly one row for the whole range.
		expect(result.data).toHaveLength(6);
		expect(result.data[0]).toMatchObject({
			flightNumber: 'FR8215',
			departureAirport: 'BCN',
			arrivalAirport: 'STN',
			price: { minorUnits: 1499, currency: 'EUR' }
		});
		expect(new Set(result.data.map((offer) => offer.departure.local.slice(0, 10))).size).toBe(6);
		expect(result.source.providerId).toBe('ryanair');
		// One month of fares, one month of timetable, one network snapshot — all cold.
		expect(result.requestsUsed).toBe(3);
	});

	it('every offer records Ryanair as its source and carries a real per-person price', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(query, { signal: new AbortController().signal });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.source).toMatchObject({ providerId: 'ryanair', fetchedAt: expect.any(String) });
		for (const offer of result.data) {
			expect(offer.priceScope).toBe('per-person');
			expect(Number.isInteger(offer.price.minorUnits)).toBe(true);
			expect(offer.price.currency).toBe('EUR');
			expect(offer.carrier.iataCode).toMatch(/^[A-Z0-9]{2}$/);
			expect(offer.flightNumber.startsWith(offer.carrier.iataCode)).toBe(true);
		}
	});

	it('passes the search currency through to the fare request', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		await provider.searchOffers({ ...query, currency: 'GBP' }, { signal: new AbortController().signal });

		const fareUrl = requestedUrls.find((url) => url.includes('/cheapestPerDay'));
		expect(fareUrl).toContain('currency=GBP');
		expect(fareUrl).toContain('outboundMonthOfDate=2026-10-01');
	});

	// The old whole-query cache key held the exact dates, so nudging one by a day missed
	// everything. Keying by calendar month means a re-dated search reuses what it has.
	it('reuses the cached month when only the dates inside it change', async () => {
		const store = new MemoryCacheStore();
		const provider = createRyanairFlightProvider({ store, fetchImpl: fixtureFetch() });

		await provider.searchOffers(query, { signal: new AbortController().signal });
		const callsAfterFirst = fetchCallCount;
		const narrower = await provider.searchOffers(
			{ ...query, earliestDeparture: '2026-10-03', latestDeparture: '2026-10-05' },
			{ signal: new AbortController().signal }
		);

		expect(narrower.ok).toBe(true);
		if (!narrower.ok) return;
		expect(narrower.requestsUsed).toBe(0);
		expect(fetchCallCount).toBe(callsAfterFirst);
		// Still clipped to the narrower window, cache hit or not.
		expect(narrower.data.map((offer) => offer.departure.local.slice(0, 10))).toEqual([
			'2026-10-03',
			'2026-10-04',
			'2026-10-05'
		]);
	});

	it('spends one fare request and one timetable request per month a window straddles', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(
			{ ...query, earliestDeparture: '2026-10-20', latestDeparture: '2026-11-05' },
			{ signal: new AbortController().signal }
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Two months of fares, two of timetable, one network snapshot.
		expect(result.requestsUsed).toBe(5);
		expect(requestedUrls.filter((url) => url.includes('/cheapestPerDay'))).toHaveLength(2);
		expect(requestedUrls.some((url) => url.endsWith('/years/2026/months/11'))).toBe(true);
	});

	// A month needs its fares AND its timetable to name a single flight, so a budget that
	// only covers one of the two buys nothing — better not to spend it at all.
	it('skips a month it cannot afford both halves of, rather than half-spending the budget', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(query, { signal: new AbortController().signal, maxRequests: 1 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual([]);
		expect(result.requestsUsed).toBe(0);
		expect(requestedUrls.some((url) => url.includes('/cheapestPerDay'))).toBe(false);
	});

	// The snapshot is asked for last and has a floor shipped with the app, so a budget that
	// covers exactly one month's two fare requests still returns that month's offers —
	// spending the last request on fares rather than on a table that can answer for free.
	it('spends a tight budget on the fares, then still maps them from the shipped snapshot', async () => {
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: fixtureFetch() });
		const result = await provider.searchOffers(query, { signal: new AbortController().signal, maxRequests: 2 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(6);
		expect(result.requestsUsed).toBe(2);
		expect(requestedUrls.some((url) => url.endsWith('/airports/en/active'))).toBe(false);
	});

	// AGENTS.md, "Show the error you got, never the one you assumed": fares that arrive with
	// no timetable to name them leave nothing to return, and an empty list would read as
	// "this route has no flights" instead of "the schedule request failed".
	it('reports the failure when the timetable is unreachable, rather than an empty list', async () => {
		const fetchImpl = fixtureFetch({
			'https://services-api.ryanair.com/timtbl': () => new Response(null, { status: 503 })
		});
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({ code: 'unknown', cause: { status: 503 } });
	});

	// A route Ryanair does not fly is not an error: `cheapestPerDay` answers 200 with a
	// month of unavailable rows and the timetable answers 200 with no days at all.
	it('returns an empty ok result for a route Ryanair does not fly', async () => {
		const fetchImpl = fixtureFetch({
			'https://services-api.ryanair.com/farfnd': () =>
				new Response(
					JSON.stringify({
						outbound: {
							fares: [
								{ day: '2026-10-01', departureDate: null, arrivalDate: null, price: null, soldOut: false, unavailable: true }
							],
							minFare: null,
							maxFare: null
						}
					}),
					{ status: 200 }
				),
			'https://services-api.ryanair.com/timtbl': () =>
				new Response(JSON.stringify({ month: 10, days: [] }), { status: 200 })
		});
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal });
		expect(result).toMatchObject({ ok: true, data: [] });
	});

	/**
	 * Issue #359. Ryanair sells the flight, names it, and prices it; this app's own airport
	 * snapshot has no zone for STN, so #93's rule refuses to date it. The old answer was an
	 * empty ok list, indistinguishable from a route with no service, which the connections
	 * map then printed as "Nothing flies here" over a real flight.
	 */
	describe('a sellable fare this app has no time zone for', () => {
		/** The real active-airports fixture with STN's zone taken out, so the fares and the
		 * timetable stay exactly as captured and the zone is the only thing missing. */
		function airportsWithoutStanstedZone(): Response {
			const airports = structuredClone(activeAirportsFixture) as { iataCode: string; timeZone?: string }[];
			for (const airport of airports) if (airport.iataCode === 'STN') delete airport.timeZone;
			return new Response(JSON.stringify(airports), { status: 200 });
		}

		const withoutStanstedZone = () =>
			fixtureFetch({
				'https://www.ryanair.com/api/views/locate/3/airports/en/active': airportsWithoutStanstedZone
			});

		it('reports no-time-zone naming the airport, rather than an empty ok result', async () => {
			const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl: withoutStanstedZone() });

			const result = await provider.searchOffers(query, { signal: new AbortController().signal });

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.code).toBe('no-time-zone');
			if (result.error.code !== 'no-time-zone') return;
			expect(result.error.airports).toEqual(['STN']);
			expect(result.error.message).toContain('STN');
		});

		// `readCachedEntry`'s caller serves an entry at any age (issue #147), so an empty
		// list written here would outlive the missing zone and keep answering "no flights"
		// long after the snapshot refresh learned where STN is.
		it('caches no empty fare list, which would re-serve the gap it found today forever', async () => {
			const store = new MemoryCacheStore();
			const written: unknown[] = [];
			const realSet = store.set.bind(store);
			store.set = async (entry) => {
				written.push(entry.value);
				return realSet(entry);
			};
			const provider = createRyanairFlightProvider({ store, fetchImpl: withoutStanstedZone() });

			const result = await provider.searchOffers(query, { signal: new AbortController().signal });

			expect(result.ok).toBe(false);
			// The raw fares, the timetable and the snapshot are all still worth keeping —
			// only the offer list this app could not build must not be written.
			expect(written.length).toBeGreaterThan(0);
			expect(written.some((value) => Array.isArray(value) && value.length === 0)).toBe(false);
		});
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
			expect(result.data).toHaveLength(6);
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
			// Awaited rather than asserted outright: the refresh reads its own per-month
			// cache entries before it reaches the network, so the request lands a tick after
			// the answer does. That it lands at all is the point.
			await vi.waitFor(() => expect(fetchCallCount).toBeGreaterThan(callsBefore));

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

		it('announces the refresh so a page rendered from the old fares can read the new ones', async () => {
			// Issue #293. Without this the fresher fares reach the next reload and never the
			// page that asked for them: `routes/results/+page.svelte` runs the search again
			// off the warmed cache when it hears this, and that second snapshot is what moves
			// a card's "fetched N ago" off the value it painted with.
			const store = new MemoryCacheStore();
			const provider = createRyanairFlightProvider({ store, fetchImpl: fixtureFetch() });
			const keys = await keysIn(store, () =>
				provider.searchOffers(query, { signal: new AbortController().signal })
			);
			await ageStoredEntriesBy(store, 2 * 60 * 60_000, keys);

			const heard: string[] = [];
			const stop = onRevalidationSettled((providerId) => heard.push(providerId));
			try {
				await provider.searchOffers(query, { signal: new AbortController().signal });
				await vi.waitFor(() => expect(heard).toContain('ryanair'));
			} finally {
				stop();
			}
		});

		it('says nothing when the refresh failed, since the cache still holds what is on screen', async () => {
			const store = new MemoryCacheStore();
			let failFares = false;
			const fetchImpl = fixtureFetch({
				'https://services-api.ryanair.com/farfnd': () =>
					failFares
						? new Response(null, { status: 503 })
						: new Response(JSON.stringify(cheapestPerDayFixture), { status: 200 })
			});
			const provider = createRyanairFlightProvider({ store, fetchImpl });
			const keys = await keysIn(store, () =>
				provider.searchOffers(query, { signal: new AbortController().signal })
			);
			await ageStoredEntriesBy(store, 2 * 60 * 60_000, keys);
			failFares = true;

			const heard: string[] = [];
			const stop = onRevalidationSettled((providerId) => heard.push(providerId));
			try {
				const callsBefore = fetchCallCount;
				await provider.searchOffers(query, { signal: new AbortController().signal });
				await vi.waitFor(() => expect(fetchCallCount).toBeGreaterThan(callsBefore));
				expect(heard).toEqual([]);
			} finally {
				stop();
			}
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
			expect(result.data).toHaveLength(6);
			expect(fetchCallCount).toBe(callsBefore);
		});

		it('keeps the cached fares and their age when the background refresh fails', async () => {
			const store = new MemoryCacheStore();
			let failFares = false;
			// Scoped to the fare path, not the whole host: the timetable lives on the same
			// origin, and answering it with a fare body would make the seed itself fail.
			const fetchImpl = fixtureFetch({
				'https://services-api.ryanair.com/farfnd': () =>
					failFares
						? new Response(null, { status: 503 })
						: new Response(JSON.stringify(cheapestPerDayFixture), { status: 200 })
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
		// A different route means fresh fares and a fresh timetable (2 requests), but the
		// snapshot from the first call is still fresh (0 requests for it).
		expect(result.requestsUsed).toBe(2);
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
		// Each call still pays for its own month of fares and timetable (two each, and the
		// duplicate STN pair races so neither sees the other's cache write), but exactly one
		// of the four is charged for the snapshot; the rest joined the same request.
		expect(results.reduce((total, r) => total + r.requestsUsed, 0)).toBe(results.length * 2 + 1);
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
		// zones and the fares still map. Before issue #121 this returned zero offers.
		expect(result.data).toHaveLength(6);
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
		expect(result).toMatchObject({ ok: false, error: { code: 'network-error' } });
	});

	it('maps a 429 to quota-exceeded without throwing', async () => {
		const fetchImpl = fixtureFetch({
			'https://services-api.ryanair.com': () => new Response(null, { status: 429 })
		});
		const provider = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		const result = await provider.searchOffers(query, { signal: new AbortController().signal });
		expect(result).toMatchObject({ ok: false, error: { code: 'quota-exceeded', status: 429 } });
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
