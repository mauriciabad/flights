/**
 * How many nights a stopover actually costs the traveller.
 *
 * Two questions, and until issue #231 the app only asked the first one. "Did the clock roll
 * past midnight" is arithmetic on two dates. "Would anybody check into a room for this" is
 * the one that decides a price, and a gap from 11pm to 5am answers yes to the first and no
 * to the second.
 *
 * The owner, looking at a card that had charged him for exactly that:
 *
 * > But we dont need a hotel in this case, it is just a few hours of waiting at the airport?
 * > (i'm assuming the schedules, i dont know if this is the case, but check it, not all night
 * > time waits require paying a hotel)
 *
 * He had already settled the zero case in issue #224 — "there shoudl be no casa in wich the
 * nights could be 0 or more, that case should just be a flight change and thats it" — and
 * issue #230 then put the shortest pairing's bed into the mandatory total. Together those
 * made the unhandled case expensive: a six-hour overnight terminal wait opened the card AND
 * carried a room nobody would sleep in.
 *
 * Pure functions, no I/O, no Svelte. `build.ts` and `recompute-selection.ts` both go through
 * `nightsToPayFor`, so a pairing and the same pairing after a picker edit can never disagree
 * about whether it has a night in it.
 */

import type { Itinerary, LocalDateTime } from '../domain';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * When the night begins and ends on the stopover's own clock, as minutes into the local day.
 *
 * 9pm to 9am. Twelve hours to hold an eight-hour sleep, and generous on purpose for the
 * reason `domain/transfer.ts` gives its own slack: this rule only has to catch the case
 * where nobody would book a bed, and every minute of margin here is a real night it cannot
 * delete by mistake.
 *
 * The end of the window is where #228 already put the start of the day. That issue's rule is
 * "land before 5am and the arrival day still counts as a full day", so on this app's clock
 * the small hours belong to the night before. Reaching to 9am rather than stopping at 5am is
 * the difference between charging and not charging a traveller who reaches the property at
 * 12:30am and leaves at 9am, which is a night by any reading; 5am would have called that a
 * terminal wait. The two rules agree about which end of the night is which, and this one is
 * the more forgiving of the pair, in the direction that keeps beds.
 */
export const NIGHT_BEGINS_MINUTES = 21 * 60;
export const NIGHT_ENDS_MINUTES = 9 * 60;

/**
 * The least time at the property, inside those night hours, that is worth a night's rate.
 *
 * Six hours. The number is arguable, so here is the argument.
 *
 * A room bought for an overnight gap buys exactly one thing, sleep, so the floor is the
 * shortest span anybody calls a night's sleep. Public-health guidance for an adult is seven
 * to nine hours; six is the conventional floor beneath it, and it is four ninety-minute
 * sleep cycles, which is the shortest whole number of them that reads as a night rather than
 * as a nap.
 *
 * Rounded DOWN out of that seven-to-nine band, not up, and the direction matters more than
 * the digit. This rule can make two mistakes. Keeping a bed the traveller did not need costs
 * them the price of a room in a total, which is the defect issue #231 reports and is
 * annoying. Deleting a bed they did need leaves a card whose total is a floor and whose
 * stopover has nowhere to sleep, which is worse, because issue #230's control can only step
 * to a DIFFERENT flight pairing — it cannot buy a bed back for this one. So the threshold
 * sits at the bottom of the plausible range, the same way `SLOWEST_USEFUL_TRANSIT_KM_PER_HOUR`
 * rounds 12.2 down to 10: the bound must never reject a night a traveller would actually
 * book.
 *
 * What it does to the shapes this app really produces, measured against the free-time window
 * (which already has both ground transfers and the airport waiting rule taken out of it, so
 * it is literally time at the property):
 *
 * | at the property | in the night | verdict |
 * | --- | --- | --- |
 * | 11:30pm to 2:30am | 3h | wait — the case on #231 |
 * | 8:30pm to 12:30am | 3h 30m | wait — an evening out, then a red-eye |
 * | 7pm to 1am | 4h | wait |
 * | 11:30pm to 4:30am | 5h | wait |
 * | 6:30pm to 3am | 6h | night |
 * | 10pm to 6am | 8h | night |
 * | 12:30am to 9am | 8h 30m | night |
 * | 10:32pm to 11:43am (BVC-LGW-PFO, the acceptance route) | 10h 28m | night |
 */
export const MIN_SLEEPABLE_MINUTES = 6 * 60;

/** A LocalDateTime's wall clock as milliseconds, offset deliberately ignored. Every edge
 * this module compares is at the same place on the same clock, which is the same reason
 * `nightsBetween` can compare bare date strings. */
function wallClockMs(dateTime: LocalDateTime): number {
	return Date.parse(`${dateTime.local}Z`);
}

function localMidnightMs(dateTime: LocalDateTime): number {
	return Date.parse(`${dateTime.local.slice(0, 10)}T00:00:00Z`);
}

/**
 * Hotel nights between two LocalDateTimes at the same place, counted the way a front desk
 * would: by calendar dates crossed, never by dividing free time by 24. A 23:00 arrival and
 * an 08:00-next-day departure is one night at nine hours; a stopover that starts and ends on
 * the same calendar date is zero nights even at twenty. Comparing calendar dates directly
 * (ignoring both clock time and UTC offset) is safe here because check-in and check-out are
 * the same place, so both dates are already in that place's own calendar.
 *
 * This is the clock's answer, not the price's. `nightsToPayFor` below is the one an
 * itinerary should carry.
 */
export function nightsBetween(start: LocalDateTime, end: LocalDateTime): number {
	return Math.round((localMidnightMs(end) - localMidnightMs(start)) / MS_PER_DAY);
}

/**
 * How much of this window the traveller could spend asleep: its overlap with the local
 * 9pm-to-9am nights it touches, in minutes.
 *
 * Nights never overlap each other (one ends at 9am, the next begins at 9pm), so summing them
 * cannot double-count. The walk starts a day early because the night that began yesterday
 * evening reaches into a window that starts after midnight.
 */
export function sleepableMinutes(start: LocalDateTime, end: LocalDateTime): number {
	const startMs = wallClockMs(start);
	const endMs = wallClockMs(end);
	if (!(endMs > startMs)) return 0;

	let overlapMs = 0;
	const firstNight = localMidnightMs(start) - MS_PER_DAY;
	const lastNight = localMidnightMs(end);
	for (let night = firstNight; night <= lastNight; night += MS_PER_DAY) {
		const nightStart = night + NIGHT_BEGINS_MINUTES * MS_PER_MINUTE;
		const nightEnd = night + MS_PER_DAY + NIGHT_ENDS_MINUTES * MS_PER_MINUTE;
		overlapMs += Math.max(0, Math.min(endMs, nightEnd) - Math.max(startMs, nightStart));
	}
	return Math.round(overlapMs / MS_PER_MINUTE);
}

/**
 * A stopover that crosses one midnight and gives the traveller too little of the night to
 * sleep through. They wait, at the airport or wherever they like, and they book nothing.
 *
 * Only ever true of a SINGLE crossed midnight, and that restriction is deliberate rather
 * than a shortcut. Two crossings means the window covers a whole calendar day, so the
 * traveller has somewhere to be for a day and a bed is real whatever the clock says at the
 * edges. The only reading a bare date subtraction can get wrong is the one crossing.
 */
export function isOvernightWait(start: LocalDateTime, end: LocalDateTime): boolean {
	return nightsBetween(start, end) === 1 && sleepableMinutes(start, end) < MIN_SLEEPABLE_MINUTES;
}

/**
 * Nights this stopover puts in the total: the calendar count, unless the one midnight it
 * crosses buys no sleep, in which case none.
 *
 * The traveller still sees the whole window — `components/free-time-days.ts` prints both
 * edges and the date they fall on, and the card names the wait and its length — so nothing
 * here hides the fact that the clock rolled over. It only stops a room being charged for it.
 */
export function nightsToPayFor(start: LocalDateTime, end: LocalDateTime): number {
	return isOvernightWait(start, end) ? 0 : nightsBetween(start, end);
}

/**
 * Whether a trip that books no night keeps the traveller up past midnight. The wording
 * question, as against `isOvernightWait`'s pricing one.
 *
 * The two used to be the same call, and issue #365 pulled them apart. `isOvernightWait`
 * asks whether the hours at the property are worth a room, so it measures against
 * `MIN_SLEEPABLE_MINUTES` on the window that had both transfers taken out of it. Once that
 * answers no, `build.ts` takes the ride to the bed off the trip and the window widens to the
 * whole layover. Measured on the owner's Porto card: 10:07pm to 3:03am becomes 9:20pm to
 * 4:10am, six hours fifty. Asking the pricing question again on the wider window gets the
 * opposite answer, and the card read "Same-day connection" over a trip that lands at 9:20pm
 * and boards at 6:10am the next morning.
 *
 * So the wording reads the calendar and the night count instead. No night booked and a
 * midnight crossed is a traveller awake in a terminal, whatever the threshold that decided
 * they were not buying a bed for it.
 */
export function waitsOvernight(
	itinerary: Pick<Itinerary, 'nightsInConnection' | 'freeTime'>
): boolean {
	if (itinerary.nightsInConnection > 0) return false;
	return nightsBetween(itinerary.freeTime.start, itinerary.freeTime.end) >= 1;
}
