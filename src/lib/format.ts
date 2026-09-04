/**
 * The one place a domain value becomes a string a screen renders.
 *
 * Before this module there were two: `results/format.ts` (the results list) and
 * `components/itinerary-timeline-format.ts` (the timeline and its pickers). They
 * disagreed. A price on a card ran through `Intl` with the default currency display and
 * `en-US`; the same price two rows lower in the expanded timeline ran through
 * `narrowSymbol` and `en-GB`. A date on a card read "Thu, Sep 10" while the timeline
 * called the same day "Thu, 10 Sep". Nothing was wrong in either file, and the app still
 * printed one trip in two dialects.
 *
 * `results/format.ts` already predicted this and named the fix: "Worth merging into a
 * shared `domain/format.ts` in a later cleanup pass (docs/prompts/006)". This is that
 * pass, landing in `$lib/format` rather than `$lib/domain` because `domain/index.ts`
 * states its own contract as "types and constants only, no logic".
 *
 * `results/format.ts` is gone and its five callers import from here directly. Leaving it
 * behind as a re-export would have been kinder to the diff and worse for the next reader,
 * who would find two modules named "format" and have to work out which one to reach for.
 * `components/itinerary-timeline-format.ts` survives because it still owns something of
 * its own, how a transfer mode is spelled and what a row says when no route came back; it
 * re-exports the rest from here.
 *
 * AGENTS.md "Money" and "Timezones" both apply and both point the same way: these are
 * read-only views. The canonical value stays integer minor units plus a currency code,
 * and a local wall-clock time plus its offset. Nothing here is ever stored or compared.
 */

import type { Duration, LocalDateTime, Money } from './domain';
import { currencyExponent, majorUnitsOf } from './domain';

/**
 * Treats a LocalDateTime's wall-clock digits as if they were UTC, purely to hand them to
 * `Intl.DateTimeFormat` without it reinterpreting them in the *viewer's* timezone. This
 * throws away the real UTC instant on purpose. See `toEpochMs` in algorithm/build.ts for
 * the function that needs the real instant instead.
 */
function asWallClockDate(dateTime: LocalDateTime): Date {
	return new Date(`${dateTime.local}Z`);
}

/**
 * "23:50": 24-hour, zero-padded, exactly the digits on the airport clock.
 *
 * Read straight off `LocalDateTime.local` with a regex rather than through `Intl`, the
 * same technique `algorithm/score.ts`'s `wallClockHours` uses and for the same reason:
 * this is a reading on a departure board at that airport, and there is no locale question
 * to answer. Falls back to the raw string if the shape is ever not what the domain
 * promises, rather than throwing inside a render.
 */
export function formatClockTime(dateTime: LocalDateTime): string {
	const match = /T(\d{2}):(\d{2})/.exec(dateTime.local);
	return match ? `${match[1]}:${match[2]}` : dateTime.local;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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

/**
 * "Fri, 4 Sep": the calendar date a traveller standing at that airport would read off a
 * departure board, regardless of what date it already is where the viewer sits.
 *
 * Built from fixed name tables plus `getUTCDay`/`getUTCDate`/`getUTCMonth` rather than
 * `Intl.DateTimeFormat`, so the exact punctuation and abbreviations this app ships do not
 * quietly change with the ICU data of whatever Node or browser renders it. Node's own
 * `en-GB` locale, for instance, abbreviates September as "Sept", not "Sep".
 */
export function formatCalendarDate(dateTime: LocalDateTime): string {
	const date = asWallClockDate(dateTime);
	return `${WEEKDAY_NAMES[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}

/** "Fri": the weekday a traveller standing at that airport would read off the departure
 * board, from the same name table and for the same reason as `formatCalendarDate`. The
 * trip strip stamps it on each free-time day so a stopover reads as "Friday evening, all
 * Saturday, Sunday morning" rather than as a duration (issue #209). */
export function formatWeekday(dateTime: LocalDateTime): string {
	return WEEKDAY_NAMES[asWallClockDate(dateTime).getUTCDay()]!;
}

/** "Friday": the long form of `formatWeekday`, for a sentence rather than a stamp. */
export function formatWeekdayLong(dateTime: LocalDateTime): string {
	return WEEKDAY_LONG_NAMES[asWallClockDate(dateTime).getUTCDay()]!;
}

/** "UTC+2", "UTC-3:30": the numeric offset stored on the LocalDateTime itself, never
 * recomputed from the IANA zone, since the same zone carries more than one offset across
 * the year. Pair with the zone name as a `title` for the reader who wants the full name. */
export function formatUtcOffset(utcOffsetMinutes: number): string {
	const sign = utcOffsetMinutes < 0 ? '-' : '+';
	const absMinutes = Math.abs(utcOffsetMinutes);
	const hours = Math.floor(absMinutes / 60);
	const minutes = absMinutes % 60;
	return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/** True when two LocalDateTimes fall on different calendar dates in their own local
 * calendars. The flag behind "this flight lands the next day". */
export function isDifferentCalendarDate(a: LocalDateTime, b: LocalDateTime): boolean {
	return a.local.slice(0, 10) !== b.local.slice(0, 10);
}

/** Whole calendar days from `a` to `b`, in their own local calendars: 1 for a flight that
 * lands after midnight, 0 for one that lands the same evening. Drives the "+1" stamp next
 * to an arrival clock instead of a second full date line. */
export function calendarDayOffset(a: LocalDateTime, b: LocalDateTime): number {
	const from = Date.parse(`${a.local.slice(0, 10)}T00:00:00Z`);
	const to = Date.parse(`${b.local.slice(0, 10)}T00:00:00Z`);
	return Math.round((to - from) / 86_400_000);
}

/** "7h 25m", "45m", "3h". Never pads with a zero component that carries no information,
 * and never prints "2.5h": this sits next to a price on a boarding-pass row and has to
 * read at a glance. Zero renders as "0m", so an edited-down waiting time is still a
 * present value rather than an empty cell. */
export function formatDuration(duration: Duration | number): string {
	const totalMinutes = Math.round(duration);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	if (minutes === 0) return `${hours}h`;
	return `${hours}h ${minutes}m`;
}

/**
 * A duration long enough to be worth reading in days: "3d 4h" rather than "76h". Only
 * used where the number really can run past a day, which in this app is total door-to-door
 * time and a multi-night stopover's free time. Below 24 hours it is exactly
 * `formatDuration`, so a short trip never suddenly renders in a different shape.
 */
export function formatLongDuration(duration: Duration | number): string {
	const totalMinutes = Math.round(duration);
	if (totalMinutes < 24 * 60) return formatDuration(totalMinutes);
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.round((totalMinutes % (24 * 60)) / 60);
	return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/**
 * Money formatted from its integer minor units. AGENTS.md "Money": convert at the edges.
 * This is that edge, and the only one a screen should use.
 *
 * `narrowSymbol` gives "¥1,500", not the ambiguous "JP¥1,500" some locales produce.
 *
 * Both the divisor and the digit count come from `currencyExponent` (domain/money.ts), the
 * same table the provider adapters scale prices INTO minor units with, so the two
 * directions cannot disagree (issue #179). Passing the digits explicitly rather than
 * letting `Intl` pick matters on a browser whose currency data is older than ours: it would
 * otherwise print two decimals on an amount we divided by one, which is a price off by a
 * factor of a hundred rather than a formatting quibble.
 */
export function formatMoney(money: Money | { minorUnits: number; currency: string }, locale = 'en-GB'): string {
	const digits = currencyExponent(money.currency);
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: money.currency,
		currencyDisplay: 'narrowSymbol',
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(majorUnitsOf(money));
}

/**
 * Issue #28: "each showing the DIFFERENCE from the currently selected flight... '+€12, 40
 * minutes later' is the comparison a person actually makes." `0` reads as "same price"
 * rather than "+€0.00", so "no difference" and "a real but tiny one" are distinguishable
 * at a glance.
 */
export function formatMoneyDelta(deltaMinorUnits: number, currency: string, locale = 'en-GB'): string {
	if (deltaMinorUnits === 0) return 'same price';
	const sign = deltaMinorUnits > 0 ? '+' : '-';
	return `${sign}${formatMoney({ minorUnits: Math.abs(deltaMinorUnits), currency }, locale)}`;
}

/** A taxi estimate's low-high range, e.g. "€18.00-€24.00". Never collapsed to a single
 * number: the whole point of the range is that neither bound is a quote. */
export function formatMoneyRange(
	lowMinorUnits: number,
	highMinorUnits: number,
	currency: string,
	locale = 'en-GB'
): string {
	return `${formatMoney({ minorUnits: lowMinorUnits, currency }, locale)}-${formatMoney({ minorUnits: highMinorUnits, currency }, locale)}`;
}

/** The "40 minutes later" half of issue #28's worked example. `0` reads as "same time",
 * matching `formatMoneyDelta`. A plain signed number rather than a `Duration`, since a
 * `Duration` is a non-negative length and a delta goes either way. */
export function formatTimeDelta(deltaMinutes: number, laterWord = 'later', earlierWord = 'earlier'): string {
	if (deltaMinutes === 0) return 'same time';
	const word = deltaMinutes > 0 ? laterWord : earlierWord;
	return `${formatDuration(Math.abs(deltaMinutes))} ${word}`;
}

/**
 * "2 hours ago", "3 days ago", for how old a cached price is (issue #35). AGENTS.md's
 * "never present an estimate as a fact" needs the age legible at a glance, not buried in
 * a raw millisecond count.
 */
export function formatAge(ageMs: number): string {
	const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
	const minutes = Math.round(ageMs / 60_000);
	if (minutes < 60) return rtf.format(-minutes, 'minute');
	const hours = Math.round(minutes / 60);
	if (hours < 24) return rtf.format(-hours, 'hour');
	const days = Math.round(hours / 24);
	return rtf.format(-days, 'day');
}

