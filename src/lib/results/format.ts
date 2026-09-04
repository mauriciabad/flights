/**
 * Display formatters for the results list (issue #23).
 *
 * This module used to carry its own `formatMoney`, `formatDuration`, `formatClockTime`,
 * `formatDayLabel` and `formatAge`, duplicating (and quietly disagreeing with) the set in
 * `components/itinerary-timeline-format.ts`. Its own header called that out and named the
 * fix: "Worth merging into a shared `domain/format.ts` in a later cleanup pass". That
 * merge has now happened, in `$lib/format`. Everything below is a re-export, kept so the
 * five call sites that import from `$lib/results/format` keep working and there is still
 * one obvious place to look for "what does the results list print".
 *
 * Two visible changes came out of the merge, both of them the two files agreeing rather
 * than a new choice: a price is formatted with `narrowSymbol` on `en-GB` everywhere
 * (cards used the default currency display on `en-US`), and a calendar day reads
 * "Thu, 10 Sep" everywhere (cards said "Thu, Sep 10" while the timeline right below them
 * said "Thu, 10 Sep").
 */

export {
	formatAge,
	formatCalendarDate,
	formatCalendarDate as formatDayLabel,
	formatClockTime,
	formatDuration,
	formatLongDuration,
	formatMoney
} from '$lib/format';
