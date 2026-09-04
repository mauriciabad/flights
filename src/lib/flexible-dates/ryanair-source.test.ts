import { describe, expect, it } from 'vitest';
import cheapestPerDayFixture from '../providers/flights/fixtures/cheapest-per-day-bcn-stn.json';
import type { RyanairCheapestPerDayResponse } from '../providers/flights/ryanair-types';
import { ryanairMonthFares } from './ryanair-source';

const OBSERVED_AT = Date.UTC(2026, 8, 4, 9, 30);

const context = {
	origin: 'BCN',
	destination: 'STN',
	monthStart: '2026-10-01',
	currency: 'EUR',
	observedAt: OBSERVED_AT
} as const;

function response(fares: unknown[]): RyanairCheapestPerDayResponse {
	return { outbound: { fares, minFare: null, maxFare: null } } as RyanairCheapestPerDayResponse;
}

describe('ryanairMonthFares', () => {
	it('reads a real captured month into dated fares', () => {
		const month = ryanairMonthFares(
			cheapestPerDayFixture as RyanairCheapestPerDayResponse,
			context
		);

		// The captured fixture is trimmed to the first six days of the month.
		expect(month.fares).toHaveLength(6);
		expect(month.everyDayUnavailable).toBe(false);
		expect(month.fares[0]).toEqual({
			departureDate: '2026-10-01',
			arrivalDate: '2026-10-01',
			minorUnits: 1499,
			providerId: 'ryanair',
			observedAt: OBSERVED_AT
		});
	});

	// `14.99 * 100` is not reliably 1499 in floating point, which is why the mapper reads
	// Ryanair's own decimal strings. Asserted here so a "simplification" back to the float
	// fails loudly.
	it('produces exact integer minor units', () => {
		const month = ryanairMonthFares(
			cheapestPerDayFixture as RyanairCheapestPerDayResponse,
			context
		);
		for (const fare of month.fares) expect(Number.isInteger(fare.minorUnits)).toBe(true);
	});

	// A route Ryanair does not fly answers 200 with a month of `unavailable: true` rows, not
	// a 404 (measured, docs/PROVIDERS.md). Reading that as "no data" would show a hole where
	// the honest answer is "this airline does not sell this route", and reading it as a fare
	// would invent a month of flights on a route with no service.
	it('reports a route with no service as blank days, not as missing data', () => {
		const month = ryanairMonthFares(
			response([
				{ day: '2026-10-01', departureDate: null, arrivalDate: null, price: null, soldOut: false, unavailable: true },
				{ day: '2026-10-02', departureDate: null, arrivalDate: null, price: null, soldOut: false, unavailable: true }
			]),
			context
		);

		expect(month.fares).toEqual([]);
		expect(month.everyDayUnavailable).toBe(true);
		expect(month.blankDays.map((blank) => blank.reason)).toEqual(['no-service', 'no-service']);
	});

	it('tells sold out apart from not flown', () => {
		const month = ryanairMonthFares(
			response([
				{ day: '2026-10-01', departureDate: '2026-10-01T06:00:00', arrivalDate: '2026-10-01T08:00:00', price: null, soldOut: true, unavailable: false },
				{ day: '2026-10-02', departureDate: null, arrivalDate: null, price: null, soldOut: false, unavailable: true }
			]),
			context
		);

		expect(month.blankDays.map((blank) => [blank.date, blank.reason])).toEqual([
			['2026-10-01', 'sold-out'],
			['2026-10-02', 'no-service']
		]);
		expect(month.everyDayUnavailable).toBe(false);
	});

	// The response covers a whole calendar month whatever range was requested, so a row for
	// another month is somebody else's data.
	it('drops rows outside the month it was asked about', () => {
		const month = ryanairMonthFares(
			response([
				{ day: '2026-09-30', departureDate: '2026-09-30T06:00:00', arrivalDate: '2026-09-30T08:00:00', price: { value: 10, valueMainUnit: '10', valueFractionalUnit: '00', currencyCode: 'EUR', currencySymbol: '€' }, soldOut: false, unavailable: false },
				{ day: '2026-10-01', departureDate: '2026-10-01T06:00:00', arrivalDate: '2026-10-01T08:00:00', price: { value: 11, valueMainUnit: '11', valueFractionalUnit: '00', currencyCode: 'EUR', currencySymbol: '€' }, soldOut: false, unavailable: false }
			]),
			context
		);

		expect(month.fares.map((fare) => fare.departureDate)).toEqual(['2026-10-01']);
	});

	// This app has no exchange-rate source. Converting would put a made-up number next to
	// real ones, so a mismatched currency is dropped instead.
	it('drops a fare quoted in another currency rather than converting it', () => {
		const month = ryanairMonthFares(
			response([
				{ day: '2026-10-01', departureDate: '2026-10-01T06:00:00', arrivalDate: '2026-10-01T08:00:00', price: { value: 11, valueMainUnit: '11', valueFractionalUnit: '00', currencyCode: 'GBP', currencySymbol: '£' }, soldOut: false, unavailable: false }
			]),
			context
		);

		expect(month.fares).toEqual([]);
	});

	it('keeps a next-day arrival as its own date', () => {
		const month = ryanairMonthFares(
			response([
				{ day: '2026-10-03', departureDate: '2026-10-03T22:55:00', arrivalDate: '2026-10-04T00:20:00', price: { value: 21.99, valueMainUnit: '21', valueFractionalUnit: '99', currencyCode: 'EUR', currencySymbol: '€' }, soldOut: false, unavailable: false }
			]),
			context
		);

		expect(month.fares[0]).toMatchObject({
			departureDate: '2026-10-03',
			arrivalDate: '2026-10-04',
			minorUnits: 2199
		});
	});

	it('survives a cache entry written by an older build', () => {
		expect(ryanairMonthFares({} as RyanairCheapestPerDayResponse, context)).toEqual({
			fares: [],
			blankDays: [],
			everyDayUnavailable: false
		});
		expect(
			ryanairMonthFares({ outbound: { fares: 'nope' } } as unknown as RyanairCheapestPerDayResponse, context)
		).toMatchObject({ fares: [] });
	});
});
