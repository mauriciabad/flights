import { describe, expect, it } from 'vitest';
import type { Duration, LocalDateTime } from '../domain';
import {
	formatCalendarDate,
	formatClockTime,
	formatDuration,
	formatMoney,
	formatUtcOffset,
	isDifferentCalendarDate
} from './itinerary-timeline-format';

function localDateTime(local: string, timeZone: string, utcOffsetMinutes: number): LocalDateTime {
	return { local, timeZone, utcOffsetMinutes };
}

describe('formatClockTime, overnight correctness', () => {
	it('reads a 00:30 arrival as 00:30, never shifted to the previous day by the machine timezone', () => {
		// Regression guard for exactly the bug AGENTS.md calls out: a 00:30 local arrival
		// must render as 00:30, not as whatever this instant happens to be in the machine
		// running the test (which is why this asserts the string, not a Date comparison).
		const arrival = localDateTime('2026-09-05T00:30:00', 'Europe/Vienna', 120);
		expect(formatClockTime(arrival)).toBe('00:30');
	});

	it('is unaffected by utcOffsetMinutes, only the local digits are ever read', () => {
		const sameWallClock = localDateTime('2026-09-05T00:30:00', 'Pacific/Auckland', 720);
		expect(formatClockTime(sameWallClock)).toBe('00:30');
	});
});

describe('formatCalendarDate, overnight correctness', () => {
	it('renders the departure date and the next-day arrival date as different, correct dates', () => {
		const departure = localDateTime('2026-09-04T22:15:00', 'Europe/Vienna', 120);
		const arrival = localDateTime('2026-09-05T00:30:00', 'Europe/Istanbul', 180);

		expect(formatCalendarDate(departure)).toBe('Fri, 4 Sep');
		expect(formatCalendarDate(arrival)).toBe('Sat, 5 Sep');
		expect(formatCalendarDate(departure)).not.toBe(formatCalendarDate(arrival));
	});
});

describe('isDifferentCalendarDate', () => {
	it('is true across an overnight flight', () => {
		const departure = localDateTime('2026-09-04T22:15:00', 'Europe/Vienna', 120);
		const arrival = localDateTime('2026-09-05T00:30:00', 'Europe/Istanbul', 180);
		expect(isDifferentCalendarDate(departure, arrival)).toBe(true);
	});

	it('is false for a same-day flight', () => {
		const departure = localDateTime('2026-09-04T08:00:00', 'Europe/Vienna', 120);
		const arrival = localDateTime('2026-09-04T09:30:00', 'Europe/Istanbul', 180);
		expect(isDifferentCalendarDate(departure, arrival)).toBe(false);
	});
});

describe('formatUtcOffset', () => {
	it('formats a positive whole-hour offset', () => {
		expect(formatUtcOffset(120)).toBe('UTC+2');
	});

	it('formats a negative offset', () => {
		expect(formatUtcOffset(-300)).toBe('UTC-5');
	});

	it('formats a half-hour offset', () => {
		expect(formatUtcOffset(330)).toBe('UTC+5:30');
	});

	it('formats zero as UTC+0', () => {
		expect(formatUtcOffset(0)).toBe('UTC+0');
	});
});

describe('formatDuration', () => {
	it('formats hours and minutes together', () => {
		expect(formatDuration(150 as Duration)).toBe('2h 30m');
	});

	it('drops the minutes when there are none', () => {
		expect(formatDuration(180 as Duration)).toBe('3h');
	});

	it('drops the hours when there are none', () => {
		expect(formatDuration(45 as Duration)).toBe('45m');
	});

	it('renders zero as 0m rather than an empty string', () => {
		expect(formatDuration(0 as Duration)).toBe('0m');
	});
});

describe('formatMoney', () => {
	it('divides EUR minor units by 100', () => {
		expect(formatMoney({ minorUnits: 12345, currency: 'EUR' })).toBe('€123.45');
	});

	it('does not divide JPY, a zero-decimal currency', () => {
		expect(formatMoney({ minorUnits: 1500, currency: 'JPY' })).toBe('¥1,500');
	});
});
