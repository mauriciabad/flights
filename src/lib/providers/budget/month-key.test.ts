import { describe, expect, it } from 'vitest';
import { monthKeyFor, secondsUntilNextMonthUtc, startOfNextMonthUtc } from './month-key';

describe('monthKeyFor', () => {
	it('formats a UTC calendar month as YYYY-MM', () => {
		expect(monthKeyFor(Date.UTC(2026, 8, 4))).toBe('2026-09');
	});

	it('pads single-digit months', () => {
		expect(monthKeyFor(Date.UTC(2026, 0, 15))).toBe('2026-01');
	});

	it('uses UTC, not the local date, right at a UTC month boundary', () => {
		// 23:30 on 31 Aug UTC is already 1 Sep in a positive-offset zone, and
		// still 31 Aug in a negative one. The key must be the UTC month
		// regardless of which machine runs the test.
		const lastInstantOfAugustUtc = Date.UTC(2026, 7, 31, 23, 30);
		expect(monthKeyFor(lastInstantOfAugustUtc)).toBe('2026-08');
		expect(monthKeyFor(lastInstantOfAugustUtc + 31 * 60 * 1000)).toBe('2026-09');
	});

	it('accepts a Date as well as a timestamp', () => {
		expect(monthKeyFor(new Date(Date.UTC(2026, 8, 4)))).toBe('2026-09');
	});

	it('defaults to the current time', () => {
		expect(monthKeyFor()).toBe(monthKeyFor(Date.now()));
	});
});

describe('secondsUntilNextMonthUtc', () => {
	it('counts down to the first instant of next month', () => {
		const oneHourBeforeSeptember = Date.UTC(2026, 7, 31, 23, 0, 0);
		expect(secondsUntilNextMonthUtc(oneHourBeforeSeptember)).toBe(60 * 60);
	});

	it('wraps December into January of the next year', () => {
		const oneMinuteBeforeNewYear = Date.UTC(2026, 11, 31, 23, 59, 0);
		expect(secondsUntilNextMonthUtc(oneMinuteBeforeNewYear)).toBe(60);
	});

	it('is never negative, right up to the last millisecond of the month', () => {
		const lastMillisecondOfAugust = Date.UTC(2026, 7, 31, 23, 59, 59, 999);
		expect(secondsUntilNextMonthUtc(lastMillisecondOfAugust)).toBe(0);
	});

	it('defaults to the current time', () => {
		expect(secondsUntilNextMonthUtc()).toBeGreaterThanOrEqual(0);
	});
});

describe('startOfNextMonthUtc', () => {
	it('lands on midnight UTC on the 1st, whatever the millisecond it was asked at', () => {
		// The reason this is a moment and not `now + secondsUntilNextMonth * 1000`: that
		// rounds to whole seconds, so a message built at 12:34:56.504 announced a quota
		// resetting at 2026-10-01T00:00:00.496Z. Caught rendering the real settings card.
		expect(startOfNextMonthUtc(Date.UTC(2026, 8, 4, 12, 34, 56, 504))).toBe(Date.UTC(2026, 9, 1));
	});

	it('wraps December into January of the next year', () => {
		expect(startOfNextMonthUtc(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
	});

	it('accepts a Date as well as a timestamp', () => {
		expect(startOfNextMonthUtc(new Date(Date.UTC(2026, 8, 4)))).toBe(Date.UTC(2026, 9, 1));
	});
});
