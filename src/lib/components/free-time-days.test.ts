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
		expect(days?.count).toBe('1 full day');
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
