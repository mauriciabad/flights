import { describe, expect, it } from 'vitest';
import type { IataAirportCode, IsoCalendarDate } from '../domain';
import type { LegFares } from '../flexible-dates';
import { legCalendarFrom } from './calendar';

const WINDOW = { from: '2027-03-08' as IsoCalendarDate, to: '2027-03-12' as IsoCalendarDate };

function makeFares(overrides: Partial<LegFares> = {}): LegFares {
	return {
		origin: 'LGW' as IataAirportCode,
		destination: 'VIE' as IataAirportCode,
		currency: 'EUR',
		fares: [],
		blankDays: [],
		months: [],
		...overrides
	};
}

describe('legCalendarFrom', () => {
	it('covers every date in the window with no gaps', () => {
		const calendar = legCalendarFrom(makeFares(), WINDOW);

		expect(calendar.days.map((day) => day.date)).toEqual([
			'2027-03-08',
			'2027-03-09',
			'2027-03-10',
			'2027-03-11',
			'2027-03-12'
		]);
	});

	it('reads a day nobody looked at as unknown, never as a day without flights', () => {
		const calendar = legCalendarFrom(makeFares(), WINDOW);

		expect(calendar.days.every((day) => day.state === 'unknown')).toBe(true);
		expect(calendar.unknown).toBe(5);
		expect(calendar.blank).toBe(0);
		expect(calendar.newestObservation).toBeUndefined();
	});

	it('keeps what the source said about a blank day, since sold out and no service differ', () => {
		const calendar = legCalendarFrom(
			makeFares({
				blankDays: [
					{ date: '2027-03-09' as IsoCalendarDate, reason: 'no-service', providerId: 'ryanair', observedAt: 100 },
					{ date: '2027-03-10' as IsoCalendarDate, reason: 'sold-out', providerId: 'ryanair', observedAt: 200 }
				]
			}),
			WINDOW
		);

		expect(calendar.days[1]).toEqual({ date: '2027-03-09', state: 'blank', reason: 'no-service' });
		expect(calendar.days[2]).toEqual({ date: '2027-03-10', state: 'blank', reason: 'sold-out' });
		expect(calendar.blank).toBe(2);
	});

	it('carries the cheapest fare and who reported it onto a priced day', () => {
		const calendar = legCalendarFrom(
			makeFares({
				fares: [
					{
						departureDate: '2027-03-08' as IsoCalendarDate,
						arrivalDate: '2027-03-08' as IsoCalendarDate,
						minorUnits: 4990,
						providerId: 'ryanair',
						observedAt: 1_700_000_000_000
					}
				]
			}),
			WINDOW
		);

		expect(calendar.days[0]).toEqual({
			date: '2027-03-08',
			state: 'priced',
			minorUnits: 4990,
			providerId: 'ryanair'
		});
		expect(calendar.priced).toBe(1);
		expect(calendar.newestObservation).toBe(1_700_000_000_000);
	});

	it('dates the strip by its newest observation, so the panel can say how old it is', () => {
		const calendar = legCalendarFrom(
			makeFares({
				fares: [
					{
						departureDate: '2027-03-08' as IsoCalendarDate,
						arrivalDate: '2027-03-08' as IsoCalendarDate,
						minorUnits: 4990,
						providerId: 'ryanair',
						observedAt: 100
					}
				],
				blankDays: [
					{ date: '2027-03-09' as IsoCalendarDate, reason: 'no-service', providerId: 'ryanair', observedAt: 900 }
				]
			}),
			WINDOW
		);

		expect(calendar.newestObservation).toBe(900);
	});

	it('ignores fares outside the window rather than stretching the strip to reach them', () => {
		const calendar = legCalendarFrom(
			makeFares({
				fares: [
					{
						departureDate: '2027-04-01' as IsoCalendarDate,
						arrivalDate: '2027-04-01' as IsoCalendarDate,
						minorUnits: 1000,
						providerId: 'ryanair',
						observedAt: 100
					}
				]
			}),
			WINDOW
		);

		expect(calendar.days).toHaveLength(5);
		expect(calendar.priced).toBe(0);
	});

	it('draws a single day for a window that starts and ends on it', () => {
		const calendar = legCalendarFrom(makeFares(), { from: WINDOW.from, to: WINDOW.from });

		expect(calendar.days.map((day) => day.date)).toEqual(['2027-03-08']);
	});
});
