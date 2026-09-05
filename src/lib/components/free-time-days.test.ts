import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDateTime } from '$lib/domain';
import { timeFormat } from '$lib/settings/time-format.svelte';
import { freeTimeDays } from './free-time-days';

/** Every reading in these cases is on the stopover airport's own clock, which is the only
 * clock this block ever prints. London in October is UTC+1. */
function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/London', utcOffsetMinutes: 60 };
}

beforeEach(() => {
	timeFormat.reset();
});

// The four blocks the owner wrote out on #228, character for character. If one of these
// ever has to change, it is a product decision and he made it, not a refactor.
describe('the blocks the owner settled on', () => {
	it('prints an evening arrival and a mid-morning departure', () => {
		const days = freeTimeDays(at('2026-10-09T21:10:00'), at('2026-10-12T09:05:00'));
		expect(days?.block).toBe('Fri 9 from 9:10pm\n2 full days: Sat, Sun\nMon 12 until 9:05am');
	});

	it('counts the landing day when the red-eye gets in before 5am', () => {
		const days = freeTimeDays(at('2026-10-10T02:15:00'), at('2026-10-12T09:05:00'));
		expect(days?.block).toBe('Sat 10 from 2:15am\n2 full days: Sat, Sun\nMon 12 until 9:05am');
	});

	it('says nothing extra when a late arrival and an early departure both fall away', () => {
		// The middle line is the whole message: Friday is absent from it. No sentence
		// explains that, which is what the owner asked for.
		const days = freeTimeDays(at('2026-10-09T23:40:00'), at('2026-10-11T04:00:00'));
		expect(days?.block).toBe('Fri 9 from 11:40pm\n1 full day: Sat\nSun 11 until 4am');
	});

	it('prints "No full days" for a mandatory one-night stopover', () => {
		const days = freeTimeDays(at('2026-10-08T21:55:00'), at('2026-10-09T04:55:00'));
		expect(days?.block).toBe('Thu 8 from 9:55pm\nNo full days\nFri 9 until 4:55am');
	});
});

describe('the 5am rule', () => {
	it('is on the arrival edge only', () => {
		// Leaving for the airport at 4:55am does not buy the Friday back. The owner's own
		// worked case, and the reason no mirror rule exists here.
		const days = freeTimeDays(at('2026-10-08T21:55:00'), at('2026-10-09T04:55:00'));
		expect(days?.fullDayCount).toBe(0);
	});

	it('stops at 5am exactly', () => {
		const justInside = freeTimeDays(at('2026-10-10T04:59:00'), at('2026-10-12T09:05:00'));
		const justOutside = freeTimeDays(at('2026-10-10T05:00:00'), at('2026-10-12T09:05:00'));
		expect(justInside?.fullDays).toBe('2 full days: Sat, Sun');
		expect(justOutside?.fullDays).toBe('1 full day: Sun');
	});

	it('does not hand a whole day to an early arrival that leaves the same day', () => {
		// In at 2am, out at 9am. That is seven hours, not a day, and the day never reaches
		// midnight.
		const days = freeTimeDays(at('2026-10-10T02:00:00'), at('2026-10-10T09:00:00'));
		expect(days?.block).toBe('Sat 10 from 2am\nNo full days\nSat 10 until 9am');
	});
});

describe('counting', () => {
	it('uses the singular for one day', () => {
		const days = freeTimeDays(at('2026-10-09T21:10:00'), at('2026-10-11T09:05:00'));
		// 9:05am is under three hours of the 8am-6pm window, so no `+`. The middle line keeps
		// #228's "full day" wording; only the compact cell label changed with #306.
		expect(days?.count).toBe('1 day');
		expect(days?.fullDays).toBe('1 full day: Sat');
	});

	it('lists a whole week by name', () => {
		const days = freeTimeDays(at('2026-10-09T21:10:00'), at('2026-10-17T09:05:00'));
		expect(days?.fullDays).toBe('7 full days: Sat, Sun, Mon, Tue, Wed, Thu, Fri');
	});

	it('spans the dates once the weekday names start repeating', () => {
		// Eight names would print two Saturdays and identify neither.
		const days = freeTimeDays(at('2026-10-09T21:10:00'), at('2026-10-18T09:05:00'));
		expect(days?.fullDays).toBe('8 full days: Sat 10 to Sat 17');
	});
});

describe('windows with nothing in them', () => {
	it('has no block for a connection with no free time at all', () => {
		expect(freeTimeDays(at('2026-10-09T21:10:00'), at('2026-10-09T21:10:00'))).toBeUndefined();
	});

	it('has no block for a window that closes before it opens', () => {
		// `build.ts` filters these out, so this is a guard against a shape reaching a render
		// rather than a case a traveller can see.
		expect(freeTimeDays(at('2026-10-09T21:10:00'), at('2026-10-09T18:00:00'))).toBeUndefined();
	});
});

describe('the 24-hour setting', () => {
	it('reaches the edge lines like every other clock in the app', () => {
		timeFormat.set('24h');
		const days = freeTimeDays(at('2026-10-09T21:10:00'), at('2026-10-12T09:05:00'));
		expect(days?.block).toBe('Fri 9 from 21:10\n2 full days: Sat, Sun\nMon 12 until 09:05');
	});
});

// Issue #306 -----------------------------------------------------------------

describe('the + suffix, and what it is allowed to claim', () => {
	it('adds nothing for an edge morning nobody could use', () => {
		// The case the issue names. 6:05am is five hours of free time and no morning at all,
		// and a `+` for it would be the app overclaiming a day it has not got.
		const days = freeTimeDays(at('2026-10-09T21:10:00'), at('2026-10-12T06:05:00'));
		expect(days?.count).toBe('2 days');
		expect(days?.countMeaning).toBeUndefined();
	});

	it('adds one for a morning that reaches into the afternoon', () => {
		const days = freeTimeDays(at('2026-10-09T21:10:00'), at('2026-10-12T13:15:00'));
		expect(days?.count).toBe('2+ days');
		expect(days?.countMeaning).toBe('Plus a usable morning on the day you leave');
	});

	it('adds one for an arrival with an afternoon left in it', () => {
		const days = freeTimeDays(at('2026-10-09T11:00:00'), at('2026-10-12T06:05:00'));
		expect(days?.count).toBe('2+ days');
		expect(days?.countMeaning).toBe('Plus a usable afternoon on the day you arrive');
	});

	it('adds two when both edges are worth something', () => {
		const days = freeTimeDays(at('2026-10-09T11:00:00'), at('2026-10-12T13:15:00'));
		expect(days?.count).toBe('2++ days');
		expect(days?.countMeaning).toBe(
			'Plus a usable afternoon on the day you arrive and a usable morning on the day you leave'
		);
	});

	it('draws the line at three hours of daylight, either side of it', () => {
		// 3pm leaves exactly three hours before the window closes at 6pm and counts. 4pm
		// leaves two and does not, because an afternoon that starts at 4pm is an evening.
		// And "1+ days", not "1+ day": the suffix says there is more than a day here, so the
		// noun agrees with the whole figure rather than with the digit in front of it.
		expect(freeTimeDays(at('2026-10-09T15:00:00'), at('2026-10-11T06:00:00'))?.count).toBe('1+ days');
		expect(freeTimeDays(at('2026-10-09T16:00:00'), at('2026-10-11T06:00:00'))?.count).toBe('1 day');
	});

	it('never counts an arrival day twice, once as full and again as a part', () => {
		// #228's landing rule already gives a 2:15am arrival its whole day. Counting the same
		// hours again as a usable afternoon would print "3+ days" for three days.
		const days = freeTimeDays(at('2026-10-10T02:15:00'), at('2026-10-13T06:00:00'));
		expect(days?.count).toBe('3 days');
		expect(days?.usablePartDayCount).toBe(0);
	});

	it('does not read a one-day window as two edges', () => {
		// A single piece is the arrival edge and the departure edge at once, and counting it
		// twice would give a seven-hour stopover a `++`.
		const days = freeTimeDays(at('2026-10-10T09:00:00'), at('2026-10-10T17:00:00'));
		expect(days?.usablePartDayCount).toBe(1);
		expect(days?.count).toBe('Part of a day');
	});
});

describe('zero whole days', () => {
	it('says "No full days" when neither edge is worth anything, as the owner wrote it', () => {
		const days = freeTimeDays(at('2026-10-08T21:55:00'), at('2026-10-09T04:55:00'));
		expect(days?.count).toBe('No full days');
	});

	it('never prints "0+ days", which reads as a bug rather than as an answer', () => {
		// The issue asks what happens here. A suffix on a zero is the same objection the
		// owner made to "0 full days" on #228, so the noun changes instead of the number.
		const days = freeTimeDays(at('2026-10-09T10:00:00'), at('2026-10-10T13:00:00'));
		expect(days?.count).toBe('Parts of 2 days');
		expect(days?.count).not.toContain('0');
	});
});
