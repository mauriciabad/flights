/**
 * Calendar arithmetic for the flexible-dates view, issue #71.
 *
 * Every function here works on `IsoCalendarDate` strings ("2026-10-01") and parses them as
 * UTC midnight, never through a local-time `Date`. AGENTS.md's timezone rule is about
 * flight instants, and this is the other half of it: a departure DATE is a date on a wall
 * calendar, so running "2026-10-01" through `new Date(...)` in Auckland and in Los Angeles
 * must not put it in two different months. `algorithm/build.ts`'s `nightsBetween` already
 * settled on the same `Date.parse('<date>T00:00:00Z')` shape for exactly this reason.
 */

import type { IsoCalendarDate } from '../domain';

const MS_PER_DAY = 86_400_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Epoch millis at UTC midnight of a calendar date, or `undefined` for anything that is
 * not a well-formed `YYYY-MM-DD`. Returns `undefined` rather than `NaN` so a caller cannot
 * accidentally propagate a silent `NaN` into a date it then renders. */
export function toUtcMidnight(date: IsoCalendarDate): number | undefined {
	if (!ISO_DATE.test(date)) return undefined;
	const ms = Date.parse(`${date}T00:00:00Z`);
	return Number.isFinite(ms) ? ms : undefined;
}

function fromUtcMidnight(ms: number): IsoCalendarDate {
	return new Date(ms).toISOString().slice(0, 10);
}

/** `addDays('2026-10-31', 1)` is `'2026-11-01'`. Invalid input comes back unchanged, which
 * keeps a malformed URL param from turning into "NaN-NaN-NaN" on screen. */
export function addDays(date: IsoCalendarDate, days: number): IsoCalendarDate {
	const ms = toUtcMidnight(date);
	if (ms === undefined) return date;
	return fromUtcMidnight(ms + days * MS_PER_DAY);
}

/** Whole days from `start` to `end`, negative when `end` is earlier. `undefined` when
 * either side is malformed. The caller decides what an unknowable gap means. */
export function daysBetween(start: IsoCalendarDate, end: IsoCalendarDate): number | undefined {
	const startMs = toUtcMidnight(start);
	const endMs = toUtcMidnight(end);
	if (startMs === undefined || endMs === undefined) return undefined;
	return Math.round((endMs - startMs) / MS_PER_DAY);
}

/** The first of the month a date falls in. */
export function monthStartOf(date: IsoCalendarDate): IsoCalendarDate {
	const match = ISO_DATE.exec(date);
	if (!match) return date;
	return `${match[1]}-${match[2]}-01`;
}

/** How many days that calendar month has, leap years included. */
export function daysInMonth(monthStart: IsoCalendarDate): number {
	const match = ISO_DATE.exec(monthStart);
	if (!match) return 0;
	// Day 0 of the next month is the last day of this one.
	return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
}

/** Every calendar month start from `from`'s month through `to`'s month, inclusive and in
 * order. Empty when either bound is malformed or `to` precedes `from`. */
export function monthStartsBetween(from: IsoCalendarDate, to: IsoCalendarDate): IsoCalendarDate[] {
	const first = monthStartOf(from);
	const last = monthStartOf(to);
	const firstMs = toUtcMidnight(first);
	const lastMs = toUtcMidnight(last);
	if (firstMs === undefined || lastMs === undefined || firstMs > lastMs) return [];

	const months: IsoCalendarDate[] = [];
	let cursor = first;
	// Bounded by construction (a year's view is 13 entries), but capped anyway so a
	// hand-edited URL asking for the year 9999 cannot spin here.
	while (cursor <= last && months.length < 120) {
		months.push(cursor);
		cursor = monthStartOf(addDays(cursor, daysInMonth(cursor)));
	}
	return months;
}

/** Every date in a calendar month, in order. */
export function datesInMonth(monthStart: IsoCalendarDate): IsoCalendarDate[] {
	const count = daysInMonth(monthStart);
	const dates: IsoCalendarDate[] = [];
	for (let i = 0; i < count; i++) dates.push(addDays(monthStart, i));
	return dates;
}

/**
 * The Monday of the ISO week a date belongs to. Monday because that is what "which week
 * should I go" means to a traveller planning around weekends, and because the grid this
 * feeds renders Mon-Sun columns.
 */
export function isoWeekStart(date: IsoCalendarDate): IsoCalendarDate {
	const ms = toUtcMidnight(date);
	if (ms === undefined) return date;
	// getUTCDay: 0 = Sunday. Shift so Monday is 0.
	const mondayIndex = (new Date(ms).getUTCDay() + 6) % 7;
	return addDays(date, -mondayIndex);
}

/** 0 for Monday through 6 for Sunday, matching `isoWeekStart`'s week. */
export function weekdayIndex(date: IsoCalendarDate): number {
	const ms = toUtcMidnight(date);
	if (ms === undefined) return 0;
	return (new Date(ms).getUTCDay() + 6) % 7;
}
