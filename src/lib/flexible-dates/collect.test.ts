import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../cache';
import type { CacheStore } from '../cache';
import cheapestPerDayFixture from '../providers/flights/fixtures/cheapest-per-day-bcn-stn.json';
import { fetchRyanairMonthGrid } from '../providers/flights/ryanair-month-grid';
import { rankWeeks, tripWindows } from './aggregate';
import { collectLegFares, fillLegMonths, missingRyanairMonths } from './collect';
import { recordLedgerFares } from './observations';
import type { LegKey } from './observations';

const NOW = Date.UTC(2026, 8, 4, 12);
const DAY = 24 * 60 * 60_000;

const outboundLeg: LegKey = { origin: 'BCN', destination: 'STN', currency: 'EUR' };
const onwardLeg: LegKey = { origin: 'STN', destination: 'OTP', currency: 'EUR' };

let store: CacheStore;
/** Every URL any code under test asked for. The point of most of this file is that it
 * stays empty. */
let requestedUrls: string[];

function countingFetch(body: unknown = cheapestPerDayFixture): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		requestedUrls.push(input.toString());
		return new Response(JSON.stringify(body), { status: 200 });
	}) as typeof fetch;
}

/** A fetch that fails the test if anything calls it. Any read path that touches this is
 * spending a request it promised not to. */
const forbiddenFetch: typeof fetch = (async (input: RequestInfo | URL) => {
	requestedUrls.push(input.toString());
	throw new Error(`a read path made a request: ${input.toString()}`);
}) as typeof fetch;

beforeEach(() => {
	store = new MemoryCacheStore();
	requestedUrls = [];
});

describe('collectLegFares', () => {
	it('reads a Ryanair month a previous search already cached, with no request of its own', async () => {
		await fetchRyanairMonthGrid(
			{ origin: 'BCN', destination: 'STN', monthStart: '2026-10-01', currency: 'EUR' },
			new AbortController().signal,
			{ store, fetchImpl: countingFetch() }
		);
		expect(requestedUrls).toHaveLength(1);
		requestedUrls = [];

		const leg = await collectLegFares(outboundLeg, ['2026-10-01'], { store, now: NOW });

		expect(requestedUrls).toEqual([]);
		expect(leg.fares).toHaveLength(6);
		expect(leg.months[0]).toMatchObject({
			monthStart: '2026-10-01',
			pricedDays: 6,
			blankDays: 0,
			unknownDays: 25
		});
		expect(leg.months[0].sources.map((source) => source.providerId)).toEqual(['ryanair']);
	});

	it('reads fares this browser recorded from an earlier search, whichever provider found them', async () => {
		await recordLedgerFares(
			onwardLeg,
			[
				{
					departureDate: '2026-10-05',
					arrivalDate: '2026-10-05',
					minorUnits: 4200,
					providerId: 'kiwi-public',
					observedAt: NOW - 2 * DAY
				}
			],
			{ store }
		);

		const leg = await collectLegFares(onwardLeg, ['2026-10-01'], { store, now: NOW });

		expect(requestedUrls).toEqual([]);
		expect(leg.fares).toEqual([
			{
				departureDate: '2026-10-05',
				arrivalDate: '2026-10-05',
				minorUnits: 4200,
				providerId: 'kiwi-public',
				observedAt: NOW - 2 * DAY
			}
		]);
	});

	it('keeps the cheapest source for a day both of them priced', async () => {
		await recordLedgerFares(
			outboundLeg,
			[
				{ departureDate: '2026-10-01', arrivalDate: '2026-10-01', minorUnits: 900, providerId: 'kiwi-public', observedAt: NOW - DAY }
			],
			{ store }
		);
		await fetchRyanairMonthGrid(
			{ origin: 'BCN', destination: 'STN', monthStart: '2026-10-01', currency: 'EUR' },
			new AbortController().signal,
			{ store, fetchImpl: countingFetch() }
		);

		const leg = await collectLegFares(outboundLeg, ['2026-10-01'], { store, now: NOW });
		const first = leg.fares.find((fare) => fare.departureDate === '2026-10-01');

		// Ryanair's own fixture has 14.99 for that day; the ledger's 9.00 is cheaper.
		expect(first).toMatchObject({ minorUnits: 900, providerId: 'kiwi-public' });
	});

	it('reports a month nobody has looked at as unknown, never as expensive', async () => {
		const leg = await collectLegFares(outboundLeg, ['2026-10-01', '2026-11-01'], {
			store,
			now: NOW
		});

		expect(requestedUrls).toEqual([]);
		expect(leg.fares).toEqual([]);
		expect(leg.months).toEqual([
			{ monthStart: '2026-10-01', pricedDays: 0, blankDays: 0, unknownDays: 31, sources: [] },
			{ monthStart: '2026-11-01', pricedDays: 0, blankDays: 0, unknownDays: 30, sources: [] }
		]);
	});

	it('drops an observation older than the ranking window rather than ranking a stale price', async () => {
		await recordLedgerFares(
			outboundLeg,
			[
				{ departureDate: '2026-10-01', arrivalDate: '2026-10-01', minorUnits: 100, providerId: 'kiwi-public', observedAt: NOW - 200 * DAY }
			],
			{ store }
		);

		const leg = await collectLegFares(outboundLeg, ['2026-10-01'], { store, now: NOW });

		expect(leg.fares).toEqual([]);
		expect(leg.months[0].pricedDays).toBe(0);
	});

	it('counts a Ryanair month with no service as blank days, not as unknown ones', async () => {
		const noService = {
			outbound: {
				fares: Array.from({ length: 31 }, (_, i) => ({
					day: `2026-10-${String(i + 1).padStart(2, '0')}`,
					departureDate: null,
					arrivalDate: null,
					price: null,
					soldOut: false,
					unavailable: true
				})),
				minFare: null,
				maxFare: null
			}
		};
		await fetchRyanairMonthGrid(
			{ origin: 'BVC', destination: 'LGW', monthStart: '2026-10-01', currency: 'EUR' },
			new AbortController().signal,
			{ store, fetchImpl: countingFetch(noService) }
		);

		const leg = await collectLegFares(
			{ origin: 'BVC', destination: 'LGW', currency: 'EUR' },
			['2026-10-01'],
			{ store, now: NOW }
		);

		expect(leg.months[0]).toMatchObject({ pricedDays: 0, blankDays: 31, unknownDays: 0 });
	});
});

/**
 * Issue #71's own acceptance criterion, asserted the way the issue words it: "Changing the
 * date window filters the view without issuing a request, proven by a test that asserts
 * zero provider calls on a re-filter."
 */
describe('re-filtering costs nothing', () => {
	it('answers every window, stopover length and re-read from what is already cached', async () => {
		await fetchRyanairMonthGrid(
			{ origin: 'BCN', destination: 'STN', monthStart: '2026-10-01', currency: 'EUR' },
			new AbortController().signal,
			{ store, fetchImpl: countingFetch() }
		);
		await fetchRyanairMonthGrid(
			{ origin: 'STN', destination: 'OTP', monthStart: '2026-10-01', currency: 'EUR' },
			new AbortController().signal,
			{ store, fetchImpl: countingFetch() }
		);
		expect(requestedUrls).toHaveLength(2);
		requestedUrls = [];

		// From here on, ANY request from anywhere, not only one this test passed a stub
		// into, throws and fails the test. `collectLegFares` takes no `fetchImpl` at all,
		// so this is the only way to prove it cannot reach the network by some other route.
		const realFetch = globalThis.fetch;
		globalThis.fetch = forbiddenFetch;
		try {
			const read = async () => ({
				outbound: await collectLegFares(outboundLeg, ['2026-10-01'], { store, now: NOW }),
				onward: await collectLegFares(onwardLeg, ['2026-10-01'], { store, now: NOW })
			});

			const { outbound, onward } = await read();

			// Six different windows and stopover lengths, each a full re-derivation.
			const shapes = [
				{ minNights: 1, maxNights: 3 },
				{ minNights: 2, maxNights: 2 },
				{ minNights: 1, maxNights: 14 },
				{ minNights: 1, maxNights: 3, from: '2026-10-03' },
				{ minNights: 1, maxNights: 3, to: '2026-10-02' },
				{ minNights: 0, maxNights: 0 }
			];
			for (const shape of shapes) {
				tripWindows(outbound.fares, onward.fares, shape);
				rankWeeks(outbound.fares, onward.fares, shape);
			}
			// And a second full read of both legs, the way remounting the page would.
			await read();
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(requestedUrls).toEqual([]);
	});
});

describe('missingRyanairMonths', () => {
	it('names exactly the months a fill would spend a request on', async () => {
		await fetchRyanairMonthGrid(
			{ origin: 'BCN', destination: 'STN', monthStart: '2026-10-01', currency: 'EUR' },
			new AbortController().signal,
			{ store, fetchImpl: countingFetch() }
		);
		requestedUrls = [];

		const missing = await missingRyanairMonths(outboundLeg, ['2026-10-01', '2026-11-01', '2026-12-01'], {
			store,
			now: NOW
		});

		expect(missing).toEqual(['2026-11-01', '2026-12-01']);
		expect(requestedUrls).toEqual([]);
	});
});

describe('fillLegMonths', () => {
	it('spends exactly one keyless request per month, in order', async () => {
		const outcomes = [];
		for await (const outcome of fillLegMonths(
			outboundLeg,
			['2026-10-01', '2026-11-01'],
			new AbortController().signal,
			{ store, fetchImpl: countingFetch() }
		)) {
			outcomes.push(outcome);
		}

		expect(outcomes.map((outcome) => outcome.monthStart)).toEqual(['2026-10-01', '2026-11-01']);
		expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
		expect(requestedUrls).toHaveLength(2);
		expect(requestedUrls[0]).toContain('outboundMonthOfDate=2026-10-01');
		// Keyless: no header, no key, no query parameter carrying one.
		expect(requestedUrls[0]).toContain('services-api.ryanair.com');
		expect(requestedUrls[0]).not.toMatch(/key|token/i);
	});

	it('stops the moment it is aborted rather than finishing the queue', async () => {
		const controller = new AbortController();
		const outcomes = [];
		for await (const outcome of fillLegMonths(
			outboundLeg,
			['2026-10-01', '2026-11-01', '2026-12-01'],
			controller.signal,
			{ store, fetchImpl: countingFetch() }
		)) {
			outcomes.push(outcome);
			controller.abort();
		}

		expect(outcomes).toHaveLength(1);
		expect(requestedUrls).toHaveLength(1);
	});

	it("reports Ryanair's own failure text rather than a guess at what it meant", async () => {
		const failing: typeof fetch = (async (input: RequestInfo | URL) => {
			requestedUrls.push(input.toString());
			return new Response('nope', { status: 503 });
		}) as typeof fetch;

		const outcomes = [];
		for await (const outcome of fillLegMonths(outboundLeg, ['2026-10-01'], new AbortController().signal, {
			store,
			fetchImpl: failing
		})) {
			outcomes.push(outcome);
		}

		expect(outcomes[0].ok).toBe(false);
		expect(outcomes[0].error).toContain('503');
	});

	it('writes into the same cache entry an ordinary search reads, so filling warms both', async () => {
		for await (const _ of fillLegMonths(outboundLeg, ['2026-10-01'], new AbortController().signal, {
			store,
			fetchImpl: countingFetch()
		})) {
			// drain
		}
		requestedUrls = [];

		const leg = await collectLegFares(outboundLeg, ['2026-10-01'], { store, now: NOW });

		expect(leg.fares).toHaveLength(6);
		expect(requestedUrls).toEqual([]);
	});
});
