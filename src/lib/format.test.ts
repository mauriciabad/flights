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
	formatPropertyRating,
	formatTimeDelta,
	formatUtcOffset,
	formatWeekday,
	formatWeekdayAndDay,
	formatWeekdayLong,
	isDifferentCalendarDate
} from './format';
import { timeFormat } from './settings/time-format.svelte';

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
		expect(formatClockTime(at('2026-10-06T00:30:00'), '24h')).toBe('00:30');
		expect(formatClockTime(at('2026-10-06T23:50:00', 'Pacific/Auckland', 780), '24h')).toBe('23:50');
	});

	it('falls back to the raw string rather than throwing on a shape the domain never promises', () => {
		expect(formatClockTime(at('not-a-datetime'), '24h')).toBe('not-a-datetime');
		expect(formatClockTime(at('not-a-datetime'), '12h')).toBe('not-a-datetime');
	});

	// Issue #229. The owner asked for am/pm and, in the same breath, "i dont like pad
	// digits, anywhere in ui".
	it('writes am/pm with no leading zero on the hour', () => {
		expect(formatClockTime(at('2026-10-12T09:05:00'), '12h')).toBe('9:05am');
		expect(formatClockTime(at('2026-10-09T21:10:00'), '12h')).toBe('9:10pm');
		expect(formatClockTime(at('2026-10-06T23:50:00'), '12h')).toBe('11:50pm');
	});

	it('names midnight and noon as twelve, not as zero', () => {
		// The pair a bare `hour % 12` renders as "0:15am" and "0:15pm". Both are on screen
		// here for any overnight stopover, since #215 splits the day at local midnight.
		expect(formatClockTime(at('2026-10-06T00:15:00'), '12h')).toBe('12:15am');
		expect(formatClockTime(at('2026-10-06T12:15:00'), '12h')).toBe('12:15pm');
		expect(formatClockTime(at('2026-10-06T00:00:00'), '12h')).toBe('12am');
		expect(formatClockTime(at('2026-10-06T12:00:00'), '12h')).toBe('12pm');
	});

	it('drops a zero minute entirely, the way the owner wrote it', () => {
		// "Sun 11 until 4am" on #228, in the same block as "Fri 9 until 4:55am".
		expect(formatClockTime(at('2026-10-11T04:00:00'), '12h')).toBe('4am');
		expect(formatClockTime(at('2026-10-11T04:55:00'), '12h')).toBe('4:55am');
	});

	it('keeps the departure-board padding in 24-hour form', () => {
		// Not an oversight about padded digits: 24-hour is the departure-board convention,
		// and a traveller who switches to it is asking for that convention.
		expect(formatClockTime(at('2026-10-12T09:05:00'), '24h')).toBe('09:05');
		expect(formatClockTime(at('2026-10-11T04:00:00'), '24h')).toBe('04:00');
	});

	it('follows the saved preference when no format is passed', () => {
		const noon = at('2026-10-06T13:45:00');
		timeFormat.reset();
		expect(formatClockTime(noon)).toBe('1:45pm');
		timeFormat.set('24h');
		expect(formatClockTime(noon)).toBe('13:45');
		timeFormat.reset();
		expect(formatClockTime(noon)).toBe('1:45pm');
	});
});

describe('formatWeekdayAndDay', () => {
	it('names the day the way the free-time block does, with no month and no padded day', () => {
		expect(formatWeekdayAndDay(at('2026-10-09T21:10:00'))).toBe('Fri 9');
		expect(formatWeekdayAndDay(at('2026-10-12T09:05:00'))).toBe('Mon 12');
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

	// Issue #217, seen on a real card as "2d 24h". Taking whole days out first and rounding
	// the leftover afterwards let the leftover round up to 24, which is a day nobody added.
	it('carries a remainder that rounds up to a whole day into the day count', () => {
		expect(formatLongDuration((2 * 1440 + 23 * 60 + 50) as Duration)).toBe('3d');
	});

	it('leaves a remainder that rounds down where it is', () => {
		expect(formatLongDuration((2 * 1440 + 23 * 60 + 29) as Duration)).toBe('2d 23h');
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

	it('prints a range whose ends agree once, since the hyphen would claim a width it has not got', () => {
		// Issue #407. Berlin sells one fare for the airport journey whichever train you
		// take, so "€5.00-€5.00" is a rendering fault rather than caution. What keeps it
		// from reading as a quote is the word "estimate" beside it, not the second number.
		expect(formatMoneyRange(500, 500, 'EUR')).toBe('€5.00');
		expect(formatMoneyRange(440, 440, 'PLN')).toBe(formatMoney({ minorUnits: 440, currency: 'PLN' }));
		expect(formatMoneyRange(190, 191, 'EUR')).toBe('€1.90-€1.91');
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

describe('formatPropertyRating', () => {
	it('prints each provider on the scale it published, not one hardcoded scale', () => {
		// #245: production printed Hostelworld's 87 as "87/5". These are the three scales
		// this repo has captured live — hostelworld-properties-london.json (63/68/88),
		// booking-search-vienna.json (7.8/7.4), agoda-search-vienna.json (4.0/5.0/1.5/3.0).
		expect(formatPropertyRating({ value: 87, outOf: 100 })).toBe('8.7/10');
		expect(formatPropertyRating({ value: 7.8, outOf: 10 })).toBe('7.8/10');
		expect(formatPropertyRating({ value: 4.4, outOf: 5 })).toBe('4.4/5');
	});

	it('always shows one decimal, so 4 out of 5 reads at the same precision as 4.4', () => {
		expect(formatPropertyRating({ value: 4, outOf: 5 })).toBe('4.0/5');
		expect(formatPropertyRating({ value: 100, outOf: 100 })).toBe('10.0/10');
	});
});
