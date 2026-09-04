/**
 * Pure display formatting for ItineraryTimeline.svelte (issue #24). Kept out of the
 * component file so the two "an overnight itinerary renders correctly" and "a duration
 * reads back the way the minutes imply" behaviours are testable without mounting Svelte.
 *
 * AGENTS.md "Timezones": "Every flight time is a local wall-clock time at a specific
 * airport... Do not normalise everything to UTC and format it back." Every function here
 * formats the `local` digits on a LocalDateTime as-is, never the real UTC instant, so an
 * arrival at 00:30 local reads as 00:30 no matter what timezone the viewer's own browser is
 * in. See `asWallClockDate` below for the mechanism.
 */

import type { Duration, LocalDateTime, TransferMode } from '../domain';

/**
 * Treats a LocalDateTime's wall-clock digits as if they were UTC, purely to hand them to
 * `Intl.DateTimeFormat` without it reinterpreting them in the *viewer's* timezone. This
 * throws away the real UTC instant on purpose. See toEpochMs in algorithm/build.ts for the
 * function that needs the real instant instead. Every formatter below pairs this with
 * `timeZone: 'UTC'` so Intl never re-shifts the digits a second time.
 */
function asWallClockDate(dateTime: LocalDateTime): Date {
	return new Date(`${dateTime.local}Z`);
}

/** "23:50": 24-hour, zero-padded, exactly the digits on the airport clock. */
export function formatClockTime(dateTime: LocalDateTime, locale = 'en-GB'): string {
	return new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZone: 'UTC'
	}).format(asWallClockDate(dateTime));
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
];

/** "Fri, 4 Sep": the calendar date a traveller standing at that airport would read off a
 * departure board, regardless of what date it already is back where the viewer sits.
 * Built from fixed name tables plus `getUTCDay`/`getUTCDate`/`getUTCMonth` rather than
 * `Intl.DateTimeFormat`, so the exact punctuation and abbreviations this app ships do not
 * quietly change with the ICU data of whatever Node or browser happens to render it. Node's
 * own `en-GB` locale, for instance, abbreviates September as "Sept", not "Sep". */
export function formatCalendarDate(dateTime: LocalDateTime): string {
	const date = asWallClockDate(dateTime);
	return `${WEEKDAY_NAMES[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}

/** "UTC+2", "UTC-3:30": the numeric offset stored on the LocalDateTime itself (never
 * recomputed from the IANA zone, since the same zone carries more than one offset across
 * the year). This is the "timezone visible" half of issue #24; pair with the IANA zone name
 * (LocalDateTime.timeZone) as a title/tooltip for the reader who wants the full name. */
export function formatUtcOffset(utcOffsetMinutes: number): string {
	const sign = utcOffsetMinutes < 0 ? '-' : '+';
	const absMinutes = Math.abs(utcOffsetMinutes);
	const hours = Math.floor(absMinutes / 60);
	const minutes = absMinutes % 60;
	return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/** True when two LocalDateTimes fall on different calendar dates in their own local
 * calendars. This is the flag ItineraryTimeline uses to decide whether a row needs to repeat the
 * date next to an arrival time, e.g. a flight that departs one date and lands the next. */
export function isDifferentCalendarDate(a: LocalDateTime, b: LocalDateTime): boolean {
	return a.local.slice(0, 10) !== b.local.slice(0, 10);
}

/** "2h 30m", "45m", "3h": never "2.5h" or a raw minute count, since this is read at a
 * glance next to a price on a boarding-pass-styled row. Zero renders as "0m" rather than an
 * empty string, so an edited-down waiting time still reads as a real, present value. */
export function formatDuration(duration: Duration): string {
	const hours = Math.floor(duration / 60);
	const minutes = duration % 60;
	if (hours === 0) return `${minutes}m`;
	if (minutes === 0) return `${hours}h`;
	return `${hours}h ${minutes}m`;
}

/** Money formatted from its integer minor units, per AGENTS.md "Money": convert at the
 * edges, never carry a formatted string as the canonical value. This is that edge. */
export function formatMoney(money: { minorUnits: number; currency: string }, locale = 'en-GB'): string {
	// Every currency this app deals with is 2 minor-unit digits or none (JPY); Intl derives
	// the right divisor from the currency code itself rather than assuming cents.
	// narrowSymbol: "¥1,500", not "JPY1,500" or the ambiguous "JP¥1,500" some locales use
	// for the plain "symbol" style.
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: money.currency,
		currencyDisplay: 'narrowSymbol'
	}).format(money.minorUnits / currencyMinorUnitDivisor(money.currency));
}

const TRANSFER_MODE_LABELS: Record<TransferMode, string> = {
	walk: 'Walk',
	transit: 'Public transport',
	taxi: 'Taxi',
	drive: 'Drive'
};

/** "Walk", "Public transport", "Taxi", "Drive": brief line 77's four transfer modes,
 * spelled out for a traveller rather than shown as the raw domain literal. */
export function transferModeLabel(mode: TransferMode): string {
	return TRANSFER_MODE_LABELS[mode];
}

/** Intl.NumberFormat wants a decimal amount, but Money stores integer minor units. This is
 * the one place that divisor is looked up, from Intl's own resolved options for the
 * currency, so a zero-decimal currency like JPY is never divided by 100 in error. */
function currencyMinorUnitDivisor(currency: string): number {
	const { minimumFractionDigits } = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency
	}).resolvedOptions();
	// TS types this as optional (recent lib.es2020.intl variants share the field across
	// numeric and currency formatting), but `style: 'currency'` always resolves it; 2 is a
	// reasonable fallback for the type checker's sake, matching most real currencies anyway.
	return 10 ** (minimumFractionDigits ?? 2);
}
