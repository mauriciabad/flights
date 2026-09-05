import { describe, expect, it } from 'vitest';
import type { LocalDateTime } from '../domain';
import {
	MIN_SLEEPABLE_MINUTES,
	isOvernightWait,
	nightsBetween,
	nightsToPayFor,
	sleepableMinutes
} from './nights';

/** Every edge in these tests is at one airport on one clock, which is the only shape this
 * module is ever handed. The offset is Gatwick's in October so the fixtures read like the
 * card that reported issue #231. */
function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/London', utcOffsetMinutes: 60 };
}

describe('nightsBetween', () => {
	it('counts calendar dates crossed, not hours', () => {
		expect(nightsBetween(at('2026-10-06T23:00:00'), at('2026-10-07T08:00:00'))).toBe(1);
		expect(nightsBetween(at('2026-10-06T02:00:00'), at('2026-10-06T22:00:00'))).toBe(0);
		expect(nightsBetween(at('2026-10-06T21:00:00'), at('2026-10-09T06:00:00'))).toBe(3);
	});
});

describe('sleepableMinutes', () => {
	it('is the overlap with the local 9pm-to-9am night', () => {
		expect(sleepableMinutes(at('2026-10-06T23:30:00'), at('2026-10-07T02:30:00'))).toBe(180);
		expect(sleepableMinutes(at('2026-10-06T22:00:00'), at('2026-10-07T06:00:00'))).toBe(480);
	});

	it('ignores the daytime part of a window that runs through it', () => {
		// 10am to 8pm is a day in the city and buys no sleep at all.
		expect(sleepableMinutes(at('2026-10-06T10:00:00'), at('2026-10-06T20:00:00'))).toBe(0);
		// 6:30pm to 3am is 8h 30m on the ground and 6h of it inside the night.
		expect(sleepableMinutes(at('2026-10-06T18:30:00'), at('2026-10-07T03:00:00'))).toBe(360);
	});

	it('picks up a night that began before the window did', () => {
		// Landed at 11:45pm, at the property by 12:30am: the sleep is all on the far side
		// of midnight and the night that holds it started the evening before.
		expect(sleepableMinutes(at('2026-10-07T00:30:00'), at('2026-10-07T09:00:00'))).toBe(510);
	});

	it('never double-counts across several nights', () => {
		// Two whole nights (12h each) plus the daytime between them, which counts nothing.
		expect(sleepableMinutes(at('2026-10-06T20:00:00'), at('2026-10-08T10:00:00'))).toBe(2 * 720);
	});

	it('is zero for a window with no length', () => {
		expect(sleepableMinutes(at('2026-10-07T02:00:00'), at('2026-10-07T02:00:00'))).toBe(0);
		expect(sleepableMinutes(at('2026-10-07T02:00:00'), at('2026-10-07T01:00:00'))).toBe(0);
	});
});

describe('isOvernightWait', () => {
	it('is true for the case on issue #231: land 11pm, fly out 5am', () => {
		expect(isOvernightWait(at('2026-10-06T23:30:00'), at('2026-10-07T02:30:00'))).toBe(true);
	});

	it('is true for an evening in the city followed by a red-eye', () => {
		expect(isOvernightWait(at('2026-10-06T20:30:00'), at('2026-10-07T00:30:00'))).toBe(true);
	});

	it('is false once the window covers six hours of the night', () => {
		expect(isOvernightWait(at('2026-10-06T22:00:00'), at('2026-10-07T04:00:00'))).toBe(false);
	});

	it('is false for a late arrival that sleeps until morning', () => {
		expect(isOvernightWait(at('2026-10-07T00:30:00'), at('2026-10-07T09:00:00'))).toBe(false);
	});

	it('is false on the acceptance route, which is a real night', () => {
		// BVC -> LGW -> PFO, measured on production: at the bed 10:32pm, leaving 11:43am.
		expect(isOvernightWait(at('2026-10-06T22:32:00'), at('2026-10-07T11:43:00'))).toBe(false);
	});

	it('never fires on a same-day connection or on a multi-night stay', () => {
		// No midnight crossed at all: already zero nights, nothing for this rule to say.
		expect(isOvernightWait(at('2026-10-06T10:00:00'), at('2026-10-06T22:00:00'))).toBe(false);
		// Two crossings means a whole calendar day on the ground, so the bed is real
		// whatever the clock reads at the two edges.
		expect(isOvernightWait(at('2026-10-06T23:30:00'), at('2026-10-08T00:30:00'))).toBe(false);
	});

	it('turns over exactly at the six-hour floor', () => {
		const start = at('2026-10-06T22:00:00');
		expect(sleepableMinutes(start, at('2026-10-07T04:00:00'))).toBe(MIN_SLEEPABLE_MINUTES);
		expect(isOvernightWait(start, at('2026-10-07T04:00:00'))).toBe(false);
		expect(isOvernightWait(start, at('2026-10-07T03:59:00'))).toBe(true);
	});
});

describe('nightsToPayFor', () => {
	it('drops the night nobody could sleep in', () => {
		expect(nightsToPayFor(at('2026-10-06T23:30:00'), at('2026-10-07T02:30:00'))).toBe(0);
	});

	it('keeps every night the traveller could', () => {
		expect(nightsToPayFor(at('2026-10-06T22:32:00'), at('2026-10-07T11:43:00'))).toBe(1);
		expect(nightsToPayFor(at('2026-10-06T21:00:00'), at('2026-10-09T06:00:00'))).toBe(3);
	});

	it('agrees with the clock whenever the clock is right', () => {
		expect(nightsToPayFor(at('2026-10-06T10:00:00'), at('2026-10-06T22:00:00'))).toBe(0);
	});
});
