import { describe, expect, it } from 'vitest';
import type { Duration, LocalDateTime, Money } from './domain';
import {
	calendarDayOffset,
	formatAge,
	formatCalendarDate,
	formatClockTime,
	formatDuration,
	formatLongDuration,
	formatMoney,
	formatMoneyDelta,
	formatMoneyRange,
	formatTimeDelta,
	formatUtcOffset,
	formatWeekday,
	formatWeekdayLong,
	isDifferentCalendarDate
} from './format';

function at(local: string, timeZone = 'Europe/Vienna', utcOffsetMinutes = 120): LocalDateTime {
	return { local, timeZone, utcOffsetMinutes };
}

const eur = (minorUnits: number): Money => ({ minorUnits, currency: 'EUR' });

describe('formatClockTime', () => {
	it('reads the wall-clock digits exactly, never reinterpreted in the viewer timezone', () => {
		// The whole point of AGENTS.md's timezone rule: a 00:30 arrival at that airport is
		// 00:30 whatever the machine rendering it thinks the time is. `TZ` is not set for
		// this suite, so this would drift if anything here went through a real `Date`
		// without pinning UTC.
		expect(formatClockTime(at('2026-10-06T00:30:00'))).toBe('00:30');
		expect(formatClockTime(at('2026-10-06T23:50:00', 'Pacific/Auckland', 780))).toBe('23:50');
	});

	it('falls back to the raw string rather than throwing on a shape the domain never promises', () => {
		expect(formatClockTime(at('not-a-datetime'))).toBe('not-a-datetime');
	});
});

describe('formatCalendarDate', () => {
	it('prints the day at that airport, from its own name tables rather than ICU data', () => {
		// Node's own en-GB abbreviates September as "Sept". The fixed tables are why this
		// app prints the same three letters on every runtime it ships to.
		expect(formatCalendarDate(at('2026-09-04T10:00:00'))).toBe('Fri, 4 Sep');
		expect(formatCalendarDate(at('2026-09-05T00:35:00'))).toBe('Sat, 5 Sep');
	});
});

describe('formatWeekday', () => {
	it('names the day on the airport clock, not the day in UTC', () => {
		// 00:30 on a Tuesday in Vienna is still Monday in UTC. The strip stamps Tuesday.
		expect(formatWeekday(at('2026-10-06T00:30:00'))).toBe('Tue');
		expect(formatWeekdayLong(at('2026-10-06T00:30:00'))).toBe('Tuesday');
	});

	it('uses the same fixed table as formatCalendarDate, so the two never disagree', () => {
		const reading = at('2026-09-04T12:00:00');
		expect(formatCalendarDate(reading).startsWith(formatWeekday(reading))).toBe(true);
	});
});

describe('isDifferentCalendarDate and calendarDayOffset', () => {
	it('sees an overnight flight as a different day, and says by how many', () => {
		const departure = at('2026-09-04T23:10:00');
		const arrival = at('2026-09-05T00:35:00');
		expect(isDifferentCalendarDate(departure, arrival)).toBe(true);
		expect(calendarDayOffset(departure, arrival)).toBe(1);
	});

	it('sees a same-evening flight as the same day', () => {
		const departure = at('2026-09-04T18:10:00');
		const arrival = at('2026-09-04T20:35:00');
		expect(isDifferentCalendarDate(departure, arrival)).toBe(false);
		expect(calendarDayOffset(departure, arrival)).toBe(0);
	});

	it('counts backwards for a flight that lands on an earlier local date than it left', () => {
		// Real, not hypothetical: eastbound across the dateline, or any long westbound hop
		// where the arrival airport's own calendar is behind the departure airport's.
		expect(calendarDayOffset(at('2026-09-05T01:00:00', 'Pacific/Auckland', 720), at('2026-09-04T14:00:00'))).toBe(
			-1
		);
	});

	it('counts a multi-day gap, which is what a long stopover between two clocks is', () => {
		expect(calendarDayOffset(at('2026-09-04T12:00:00'), at('2026-09-07T09:00:00'))).toBe(3);
	});
});

describe('formatDuration', () => {
	it('never pads with a component that carries no information', () => {
		expect(formatDuration(445 as Duration)).toBe('7h 25m');
		expect(formatDuration(45 as Duration)).toBe('45m');
		expect(formatDuration(180 as Duration)).toBe('3h');
	});

	it('renders zero as a real value, so an edited-down buffer is not an empty cell', () => {
		expect(formatDuration(0 as Duration)).toBe('0m');
	});
});

describe('formatLongDuration', () => {
	it('switches to days only once there is a day to report', () => {
		expect(formatLongDuration(1439 as Duration)).toBe('23h 59m');
		expect(formatLongDuration(1440 as Duration)).toBe('1d');
		expect(formatLongDuration(4560 as Duration)).toBe('3d 4h');
	});
});

describe('formatMoney', () => {
	it('divides by the currency’s own minor unit, never a hardcoded 100', () => {
		expect(formatMoney(eur(23800))).toBe('€238.00');
		// JPY has no minor unit at all; dividing by 100 here would print ¥15.
		expect(formatMoney({ minorUnits: 1500, currency: 'JPY' })).toBe('¥1,500');
	});

	it('uses the narrow symbol, so a dollar is a dollar and not "US$"', () => {
		expect(formatMoney({ minorUnits: 4400, currency: 'USD' })).toBe('$44.00');
	});

	// Issue #179: the divisor and the printed digit count both come from `currencyExponent`
	// (domain/money.ts), the same table the adapters parse a provider's price with. A
	// forint fare is stored with two decimal digits, so it has to print with two.
	it('prints the forint with the two decimal digits it is parsed with', () => {
		expect(formatMoney({ minorUnits: 4500000, currency: 'HUF' })).toBe('Ft\u00a045,000.00');
	});

	it('prints a three-decimal dinar with three', () => {
		expect(formatMoney({ minorUnits: 1500, currency: 'KWD' })).toBe('KWD\u00a01.500');
	});

	it('assumes cents for a code nothing knows, matching what parsing assumed', () => {
		expect(formatMoney({ minorUnits: 1000, currency: 'XYZ' })).toBe('XYZ\u00a010.00');
	});
});

describe('deltas', () => {
	it('says "same" rather than a signed zero, so no difference is legible as no difference', () => {
		expect(formatMoneyDelta(0, 'EUR')).toBe('same price');
		expect(formatTimeDelta(0)).toBe('same time');
	});

	it('signs a real difference in both directions', () => {
		expect(formatMoneyDelta(1200, 'EUR')).toBe('+€12.00');
		expect(formatMoneyDelta(-1200, 'EUR')).toBe('-€12.00');
		expect(formatTimeDelta(40)).toBe('40m later');
		expect(formatTimeDelta(-95)).toBe('1h 35m earlier');
	});

	it('keeps a taxi estimate as a range, since neither bound is a quote', () => {
		expect(formatMoneyRange(1800, 2400, 'EUR')).toBe('€18.00-€24.00');
	});
});

describe('formatUtcOffset', () => {
	it('prints half-hour and negative offsets the way the airport does', () => {
		expect(formatUtcOffset(120)).toBe('UTC+2');
		expect(formatUtcOffset(-210)).toBe('UTC-3:30');
		expect(formatUtcOffset(0)).toBe('UTC+0');
	});
});

describe('formatAge', () => {
	it('steps up a unit rather than printing a large count of a small one', () => {
		expect(formatAge(5 * 60_000)).toBe('5 minutes ago');
		expect(formatAge(3 * 60 * 60_000)).toBe('3 hours ago');
		expect(formatAge(2 * 24 * 60 * 60_000)).toBe('2 days ago');
	});
});
