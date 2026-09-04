/**
 * Small display-only formatters for the results list (issue #23). Each one turns a
 * canonical domain value into a string a card can render, never the other way round, and
 * never used as a value anything compares or stores (AGENTS.md "Money" and "Timezones":
 * the canonical values stay integer minor units and local-plus-offset, these are read-only
 * views of them).
 *
 * `formatMoney` mirrors the private helper of the same name in `algorithm/crosscheck.ts`
 * rather than importing it, that one is module-private by design, and the two are small
 * enough that duplicating beats reaching into another issue's internals. Worth merging
 * into a shared `domain/format.ts` in a later cleanup pass (docs/prompts/006), not here.
 */

import type { Duration, LocalDateTime, Money } from '$lib/domain';

/**
 * Display only, never the canonical value. `Intl` already knows how many decimal places
 * each currency uses (0 for JPY, 3 for KWD, 2 for most), which is exactly what turning
 * integer minor units back into a display amount needs, without a currency-to-exponent
 * table of this module's own.
 */
export function formatMoney(money: Money): string {
	const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: money.currency });
	const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
	return formatter.format(money.minorUnits / 10 ** digits);
}

/** "7h 25m", "45m", "3h", never pads with a zero component that carries no information. */
export function formatDuration(duration: Duration): string {
	const totalMinutes = Math.round(duration);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	if (minutes === 0) return `${hours}h`;
	return `${hours}h ${minutes}m`;
}

/**
 * Reads the wall-clock hour and minute straight off `LocalDateTime.local` with a regex,
 * the same technique `algorithm/score.ts`'s `wallClockHours` uses and for the same reason:
 * this is the reading on the departure board at that airport, and parsing it through `Date`
 * would silently reinterpret it in the runtime's own timezone instead.
 */
export function formatClockTime(dateTime: LocalDateTime): string {
	const match = /T(\d{2}):(\d{2})/.exec(dateTime.local);
	return match ? `${match[1]}:${match[2]}` : dateTime.local;
}

/**
 * Treats `LocalDateTime.local`'s digits as if they were UTC (matching
 * `algorithm/build.ts`'s `toEpochMs` trick) purely to hand a real `Date` to
 * `Intl.DateTimeFormat` for a calendar reading, `timeZone: 'UTC'` on the formatter below
 * is what makes that safe, since without it the formatter would reinterpret the instant in
 * the browser's own zone and could print the wrong calendar day.
 */
function wallClockAsFormattableDate(dateTime: LocalDateTime): Date {
	return new Date(`${dateTime.local}Z`);
}

/** "Thu, Sep 10", the calendar day a LocalDateTime falls on, at the place it describes. */
export function formatDayLabel(dateTime: LocalDateTime): string {
	return new Intl.DateTimeFormat('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	}).format(wallClockAsFormattableDate(dateTime));
}

/**
 * "2 hours ago", "3 days ago", for `ExpiredFallbackResult.ageMs` (issue #35), where
 * AGENTS.md's "never present an estimate as a fact" means the age has to be legible at a
 * glance, not buried in a raw millisecond count.
 */
export function formatAge(ageMs: number): string {
	const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
	const minutes = Math.round(ageMs / 60_000);
	if (minutes < 60) return rtf.format(-minutes, 'minute');
	const hours = Math.round(minutes / 60);
	if (hours < 24) return rtf.format(-hours, 'hour');
	const days = Math.round(hours / 24);
	return rtf.format(-days, 'day');
}
