/**
 * Ryanair's own APIs give a wall-clock local time with no UTC offset attached (e.g.
 * "2026-10-13T09:10:00") and, on a different endpoint, the IANA zone name for the
 * airport. Domain's `LocalDateTime` (AGENTS.md "Timezones") needs the numeric offset
 * stored alongside both, so this file derives it from the platform's own timezone
 * database via `Intl` instead of adding a date-library dependency for one calculation.
 */

import type { Duration, LocalDateTime } from '../../domain';

/** Parses a wall-clock ISO string (no zone suffix) as if it were UTC, giving a same-day
 * numeric instant to anchor the offset lookup below — not a real instant on its own. */
function parseAsIfUtc(localIso: string): number {
	const ms = Date.parse(`${localIso}Z`);
	if (Number.isNaN(ms)) {
		throw new RangeError(`"${localIso}" is not a valid ISO local date-time`);
	}
	return ms;
}

/** The UTC offset, in minutes, `timeZone` has at the real instant `instantMs` — found by
 * formatting that instant's wall clock in `timeZone` and comparing it back against the
 * instant itself. `Intl.DateTimeFormat` already carries the same tz database every
 * browser and Node ships with, so this needs no extra dependency. */
function offsetMinutesAt(instantMs: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(new Date(instantMs));

	const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
	const wallClockAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
	return Math.round((wallClockAsUtcMs - instantMs) / 60_000);
}

/**
 * The UTC offset, in minutes, that `timeZone` was at when its wall clock read exactly
 * `localIso` (e.g. "2026-10-13T09:10:00"). Two passes: the first treats the wall-clock
 * digits as if they were already UTC to get a same-day estimate of the real instant, then
 * re-reads the offset AT that estimate. One pass is not always enough — a wall-clock time
 * that falls right at a DST transition can have a different offset than the naive first
 * guess, and this project would rather spend one extra `Intl` call than get that hour
 * wrong for a handful of flights a year.
 */
export function computeUtcOffsetMinutes(localIso: string, timeZone: string): number {
	const naiveInstantMs = parseAsIfUtc(localIso);
	const firstPassOffset = offsetMinutesAt(naiveInstantMs, timeZone);
	return offsetMinutesAt(naiveInstantMs - firstPassOffset * 60_000, timeZone);
}

/** Builds a domain `LocalDateTime` from a Ryanair wall-clock string and the airport's IANA
 * zone, filling in the offset AGENTS.md requires be stored rather than derived later by
 * every consumer. */
export function toLocalDateTime(localIso: string, timeZone: string): LocalDateTime {
	return { local: localIso, timeZone, utcOffsetMinutes: computeUtcOffsetMinutes(localIso, timeZone) };
}

/** The real elapsed time between two LocalDateTimes, resolved to actual UTC instants
 * first — never a naive string subtraction, which is exactly how an overnight or
 * offset-crossing connection would silently lose or gain an hour (AGENTS.md
 * "Timezones": "a lost night is a wrong price and a wrong hotel booking"). */
export function computeFlightDuration(departure: LocalDateTime, arrival: LocalDateTime): Duration {
	const departureInstantMs = parseAsIfUtc(departure.local) - departure.utcOffsetMinutes * 60_000;
	const arrivalInstantMs = parseAsIfUtc(arrival.local) - arrival.utcOffsetMinutes * 60_000;
	return Math.round((arrivalInstantMs - departureInstantMs) / 60_000) as Duration;
}
