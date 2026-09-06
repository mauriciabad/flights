/**
 * Wall-clock arithmetic for a schedule that spans several timezones.
 *
 * These three lived in `build.ts` until issue #368 needed the free-time window to read a
 * transit timetable. `algorithm/transit-schedule.ts` owns the one derivation of the moment
 * a leg's lookup was planned for, and `build.ts` now has to ask it that question, so the
 * two modules would have imported each other. Datetime arithmetic sits below both, which
 * is where it always belonged: none of it knows what an itinerary is.
 *
 * `build.ts` still re-exports all three, so nothing else moved.
 */

import type { Duration, LocalDateTime } from '../domain';

/**
 * The true instant a LocalDateTime represents, in epoch milliseconds. Every LocalDateTime
 * already carries the correct UTC offset for that specific wall-clock moment (see
 * domain/datetime.ts), so this needs no timezone database of its own: parse the digits as
 * if they were UTC, then remove the stored offset. Two LocalDateTimes on either side of a
 * DST change carry different `utcOffsetMinutes`, so subtracting their instants (see
 * `minutesBetween`) gains or loses the real hour instead of the naive wall-clock difference.
 */
function toEpochMs(dateTime: LocalDateTime): number {
	const wallClockAsUtcMs = Date.parse(`${dateTime.local}Z`);
	return wallClockAsUtcMs - dateTime.utcOffsetMinutes * 60_000;
}

/** Real elapsed time between two LocalDateTimes, DST-correct per `toEpochMs` above. This is
 * how layover and free time are computed — never by subtracting the `local` strings
 * directly, which is exactly the bug that makes an overnight connection lose an hour. */
export function minutesBetween(from: LocalDateTime, to: LocalDateTime): Duration {
	return Math.round((toEpochMs(to) - toEpochMs(from)) / 60_000) as Duration;
}

/**
 * Shifts a LocalDateTime by a short local duration — an airport-to-hotel transfer, a
 * pre-boarding buffer — keeping its `timeZone` and `utcOffsetMinutes` unchanged. That is
 * only correct because every duration this is used with (a terminal transfer, a waiting-time
 * buffer) is minutes long and happens well away from the couple of hours around a DST
 * transition; it is not a general "add a duration in this timezone" function. The
 * multi-hour, potentially DST-crossing gap between the two flights is handled the other way
 * round, by subtracting each flight's own already-correct LocalDateTime (`minutesBetween`),
 * never by walking forward minute-by-minute through this one.
 */
export function addLocalMinutes(dateTime: LocalDateTime, minutes: number): LocalDateTime {
	const shiftedMs = Date.parse(`${dateTime.local}Z`) + minutes * 60_000;
	return {
		local: new Date(shiftedMs).toISOString().slice(0, 19),
		timeZone: dateTime.timeZone,
		utcOffsetMinutes: dateTime.utcOffsetMinutes
	};
}
