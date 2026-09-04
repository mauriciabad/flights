import { describe, expect, it } from 'vitest';
import priceCalendarBcnVie from './fixtures/flights-sky-price-calendar-bcn-vie.json';
import { FlightsSkyMalformedCalendarResponseError, mapPriceCalendarDays } from './flights-sky-map-calendar';

describe('mapPriceCalendarDays', () => {
	it('maps every day of the real captured fixture', () => {
		// Measured 2026-09-04 against a real BCN-VIE call: 366 contiguous days, today
		// through exactly a year forward — see this file's header comment in
		// flights-sky-map-calendar.ts and the PR description for the full evidence.
		const days = mapPriceCalendarDays(priceCalendarBcnVie, 'EUR');
		expect(days).toHaveLength(366);
		expect(days[0]).toEqual({ date: '2026-09-04', group: 'high', price: { minorUnits: 12400, currency: 'EUR' } });
		expect(days.at(-1)).toEqual({
			date: '2027-09-04',
			group: 'medium',
			price: { minorUnits: 5399, currency: 'EUR' }
		});
	});

	it('converts a known cheap day to minor units without a float rounding bug', () => {
		const days = mapPriceCalendarDays(priceCalendarBcnVie, 'EUR');
		const day = days.find((d) => d.date === '2026-09-15');
		expect(day).toEqual({ date: '2026-09-15', group: 'low', price: { minorUnits: 3400, currency: 'EUR' } });
	});

	it('keeps every day within the API\'s own low/medium/high banding', () => {
		const days = mapPriceCalendarDays(priceCalendarBcnVie, 'EUR');
		const groups = new Set(days.map((d) => d.group));
		expect([...groups].sort()).toEqual(['high', 'low', 'medium']);
	});

	it('drops a day with an unrecognised group rather than guessing a banding for it', () => {
		const raw = { data: { flights: { days: [{ day: '2026-09-04', group: 'bargain', price: 10 }] } } };
		expect(mapPriceCalendarDays(raw, 'EUR')).toEqual([]);
	});

	it('drops a day with a missing or non-numeric price', () => {
		const raw = {
			data: { flights: { days: [{ day: '2026-09-04', group: 'low' }, { day: '2026-09-05', group: 'low', price: 'n/a' }] } }
		};
		expect(mapPriceCalendarDays(raw, 'EUR')).toEqual([]);
	});

	it('throws FlightsSkyMalformedCalendarResponseError when data.flights.days is missing entirely', () => {
		expect(() => mapPriceCalendarDays({ data: { flights: {} } }, 'EUR')).toThrow(
			FlightsSkyMalformedCalendarResponseError
		);
	});
});
