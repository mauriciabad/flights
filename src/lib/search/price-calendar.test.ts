import { describe, expect, it } from 'vitest';
import type { AvailableKeys, FlightProvider, ProviderContext } from '../providers/types';
import {
	estimatePriceCalendarWidenCost,
	hasPriceCalendar,
	priceCalendarProviders,
	runPriceCalendarWiden
} from './price-calendar';
import type { FlightsSkyProvider, PriceCalendarDay, PriceCalendarQuery } from './price-calendar';

function plainFlightProvider(id: string): FlightProvider {
	return {
		kind: 'flight',
		id,
		label: `Plain (${id})`,
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: {}, source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' }, requestsUsed: 0 };
		},
		estimateSearchOffersCost: () => 0,
		async searchOffers() {
			return { ok: true, data: [], source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' }, requestsUsed: 0 };
		},
		async listDirectDestinations() {
			return { ok: true, data: [], source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' }, requestsUsed: 0 };
		}
	};
}

function calendarDay(date: string, minorUnits: number): PriceCalendarDay {
	return { date, price: { minorUnits, currency: 'EUR' }, group: 'low' };
}

/**
 * A `FlightsSkyProvider`-shaped fake: `estimatePriceCalendarCost`/`getPriceCalendar` sit
 * flat on the provider, exactly like the real Flights Sky adapter (issue #61,
 * `providers/flights/flights-sky.ts`, `FlightsSkyProvider = FlightProvider &
 * FlightPriceCalendarProvider`) rather than nested under a sub-object — that real shape is
 * what this fixture mirrors, not a shape this package invents.
 */
function calendarCapableProvider(
	id: string,
	options: { needsKey?: boolean; costPerCall?: number; alwaysFails?: boolean } = {}
): FlightsSkyProvider {
	const base = plainFlightProvider(id);
	const needsKey = options.needsKey ?? true;
	const costPerCall = options.costPerCall ?? 1;

	return {
		...base,
		needsKey,
		keyFields: needsKey ? [{ id: 'apiKey', label: 'Key' }] : [],
		estimatePriceCalendarCost: () => costPerCall,
		async getPriceCalendar(query: PriceCalendarQuery, ctx: ProviderContext) {
			if (options.alwaysFails) {
				return {
					ok: false as const,
					error: { code: 'network-error' as const, message: 'fixture failure' },
					source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' },
					requestsUsed: 0
				};
			}
			if (ctx.maxRequests !== undefined && ctx.maxRequests < costPerCall) {
				return { ok: true as const, data: [], source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' }, requestsUsed: 0 };
			}
			return {
				ok: true as const,
				data: [calendarDay(query.departDate, 3300)],
				source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' },
				requestsUsed: costPerCall
			};
		}
	};
}

describe('hasPriceCalendar / priceCalendarProviders', () => {
	it('is false for a plain FlightProvider and true for one with a price calendar', () => {
		const plain = plainFlightProvider('ryanair');
		const capable = calendarCapableProvider('flights-sky');

		expect(hasPriceCalendar(plain)).toBe(false);
		expect(hasPriceCalendar(capable)).toBe(true);
		expect(priceCalendarProviders([plain, capable]).map((p) => p.id)).toEqual(['flights-sky']);
	});
});

describe('estimatePriceCalendarWidenCost', () => {
	it('lists a calendar-capable provider with tier "calendar", including one with no key yet', () => {
		const capable = calendarCapableProvider('flights-sky', { needsKey: true });
		const plain = plainFlightProvider('ryanair');
		const query: PriceCalendarQuery = { origin: 'ZOR', destination: 'ZFA', departDate: '2026-10-01' };

		const options = estimatePriceCalendarWidenCost([capable, plain], {}, [query, query]);

		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			providerId: 'flights-sky',
			kind: 'flight',
			tier: 'calendar',
			requests: 2, // one per leg
			requiresKey: true
		});
	});

	it('reports requiresKey: false once a key is configured', () => {
		const capable = calendarCapableProvider('flights-sky');
		const query: PriceCalendarQuery = { origin: 'ZOR', destination: 'ZFA', departDate: '2026-10-01' };
		const keys: AvailableKeys = { 'flights-sky': { apiKey: 'secret' } };

		const options = estimatePriceCalendarWidenCost([capable], keys, [query]);
		expect(options[0].requiresKey).toBe(false);
	});
});

describe('runPriceCalendarWiden', () => {
	const legQueriesFor = (code: string) => ({
		outbound: { origin: 'ZOR', destination: code, departDate: '2026-10-01' },
		onward: { origin: code, destination: 'ZDE', departDate: '2026-10-01' }
	});

	it('streams one outcome per candidate/leg/provider and never exceeds the budget', async () => {
		const provider = calendarCapableProvider('flights-sky', { costPerCall: 1 });
		const keys: AvailableKeys = { 'flights-sky': { apiKey: 'secret' } };
		const controller = new AbortController();

		// Two candidates x two legs x one provider = 4 possible calls; budget only allows 3.
		const outcomes = [];
		for await (const outcome of runPriceCalendarWiden(
			['ZFA', 'ZSL'],
			legQueriesFor,
			[provider],
			keys,
			controller.signal,
			3
		)) {
			outcomes.push(outcome);
		}

		expect(outcomes).toHaveLength(3);
		const totalSpent = outcomes.reduce((sum, o) => sum + o.result.requestsUsed, 0);
		expect(totalSpent).toBeLessThanOrEqual(3);
	});

	it('never calls a provider with no key configured', async () => {
		const provider = calendarCapableProvider('flights-sky', { needsKey: true });
		const controller = new AbortController();

		const outcomes = [];
		for await (const outcome of runPriceCalendarWiden(['ZFA'], legQueriesFor, [provider], {}, controller.signal, 10)) {
			outcomes.push(outcome);
		}

		expect(outcomes).toHaveLength(0);
	});

	it('surfaces a failing provider as a failed outcome rather than throwing', async () => {
		const provider = calendarCapableProvider('flights-sky', { alwaysFails: true });
		const keys: AvailableKeys = { 'flights-sky': { apiKey: 'secret' } };
		const controller = new AbortController();

		const outcomes = [];
		for await (const outcome of runPriceCalendarWiden(['ZFA'], legQueriesFor, [provider], keys, controller.signal, 10)) {
			outcomes.push(outcome);
		}

		expect(outcomes).toHaveLength(2); // outbound + onward, both attempted
		expect(outcomes.every((o) => o.result.ok === false)).toBe(true);
	});

	it('spends nothing with a budget of zero', async () => {
		const provider = calendarCapableProvider('flights-sky');
		const keys: AvailableKeys = { 'flights-sky': { apiKey: 'secret' } };
		const controller = new AbortController();

		const outcomes = [];
		for await (const outcome of runPriceCalendarWiden(['ZFA'], legQueriesFor, [provider], keys, controller.signal, 0)) {
			outcomes.push(outcome);
		}

		expect(outcomes).toHaveLength(0);
	});
});
