import { describe, expect, it } from 'vitest';
import { monthKeyFor } from './month-key';

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
