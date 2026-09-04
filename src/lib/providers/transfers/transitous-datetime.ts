/**
 * Every timestamp Transitous's `/plan` endpoint sends or accepts is a bare UTC instant
 * (`2026-09-10T09:02:00Z`). The domain model never stores a bare instant for anything a
 * traveller reads a clock for (AGENTS.md "Timezones": "a 00:30 local arrival is still
 * 'today' on the airport clock but already 'tomorrow' in UTC"), so every value crossing
 * this adapter's boundary gets converted here, in one place, rather than ad hoc at each
 * call site.
 */

import type { LocalDateTime } from '../../domain';

/**
 * `LocalDateTime` -> the UTC instant Transitous's `time` query parameter expects.
 * `local` reads as a wall-clock time with no zone of its own; parsing it as if it *were*
 * UTC gives a "fake" instant offset from the truth by exactly `utcOffsetMinutes`, which is
 * what lets this be a pure arithmetic conversion rather than needing a timezone database.
 */
export function localDateTimeToUtcInstant(local: LocalDateTime): Date {
	const fakeUtcMs = Date.parse(`${local.local}Z`);
	return new Date(fakeUtcMs - local.utcOffsetMinutes * 60_000);
}

/**
 * The inverse: a UTC instant plus an IANA zone -> the wall-clock reading at that place.
 * `utcOffsetMinutes` is derived rather than looked up from a table, by formatting the
 * instant into `timeZone` and measuring how far that reading sits from the true instant —
 * the same trick as above, run backwards. This is also why callers pass `timeZone`
 * per-timestamp rather than once for a whole journey: a transfer that crosses a zone
 * boundary (rare, but Transitous names a zone on every place it returns) gets each leg's
 * own offset right instead of inheriting the origin's.
 */
export function utcInstantToLocalDateTime(utcIso: string, timeZone: string): LocalDateTime {
	const instant = new Date(utcIso);
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	const parts = Object.fromEntries(
		formatter.formatToParts(instant).map((part) => [part.type, part.value])
	) as Record<string, string>;
	const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
	const fakeUtcMs = Date.parse(`${local}Z`);
	const utcOffsetMinutes = Math.round((fakeUtcMs - instant.getTime()) / 60_000);
	return { local, timeZone, utcOffsetMinutes };
}
