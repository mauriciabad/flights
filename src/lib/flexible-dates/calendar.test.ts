import { describe, expect, it } from 'vitest';
import {
	addDays,
	datesInMonth,
	daysBetween,
	daysInMonth,
	isoWeekStart,
	monthStartOf,
	monthStartsBetween,
	toUtcMidnight,
	weekdayIndex
} from './calendar';

describe('calendar', () => {
	it('crosses a month boundary', () => {
		expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
	});

	it('crosses a leap day', () => {
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
		expect(daysInMonth('2028-02-01')).toBe(29);
		expect(daysInMonth('2026-02-01')).toBe(28);
	});

	// A departure date is a wall-calendar date. Parsing it through a local-time `Date` would
	// put "2026-10-01" in September for anyone west of UTC, and this whole feature buckets
	// by month.
	it('does not depend on the machine timezone', () => {
		expect(toUtcMidnight('2026-10-01')).toBe(Date.UTC(2026, 9, 1));
		expect(monthStartOf('2026-10-01')).toBe('2026-10-01');
		expect(monthStartOf('2026-10-31')).toBe('2026-10-01');
	});

	it('refuses a malformed date instead of returning NaN', () => {
		expect(toUtcMidnight('not-a-date')).toBeUndefined();
		expect(daysBetween('2026-10-01', 'nope')).toBeUndefined();
		expect(addDays('nope', 3)).toBe('nope');
	});

	it('counts days between dates in both directions', () => {
		expect(daysBetween('2026-10-01', '2026-10-04')).toBe(3);
		expect(daysBetween('2026-10-04', '2026-10-01')).toBe(-3);
		expect(daysBetween('2026-10-01', '2026-10-01')).toBe(0);
	});

	it('lists every month a range touches, inclusive at both ends', () => {
		expect(monthStartsBetween('2026-10-15', '2027-01-02')).toEqual([
			'2026-10-01',
			'2026-11-01',
			'2026-12-01',
			'2027-01-01'
		]);
		expect(monthStartsBetween('2026-10-15', '2026-10-16')).toEqual(['2026-10-01']);
		expect(monthStartsBetween('2026-10-15', '2026-09-16')).toEqual([]);
	});

	it('spans a year in thirteen month buckets', () => {
		expect(monthStartsBetween('2026-09-04', '2027-09-04')).toHaveLength(13);
	});

	it('lists a month day by day', () => {
		const days = datesInMonth('2026-11-01');
		expect(days).toHaveLength(30);
		expect(days[0]).toBe('2026-11-01');
		expect(days[29]).toBe('2026-11-30');
	});

	it('puts a week on its Monday', () => {
		// 2026-10-01 is a Thursday.
		expect(isoWeekStart('2026-10-01')).toBe('2026-09-28');
		expect(weekdayIndex('2026-10-01')).toBe(3);
		// A Sunday belongs to the week that started six days earlier, not the next one.
		expect(isoWeekStart('2026-10-04')).toBe('2026-09-28');
		expect(weekdayIndex('2026-10-04')).toBe(6);
		expect(isoWeekStart('2026-10-05')).toBe('2026-10-05');
		expect(weekdayIndex('2026-10-05')).toBe(0);
	});
});
