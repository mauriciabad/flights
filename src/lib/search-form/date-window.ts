/**
 * The four date fields as what they actually are: two ranges anchored to the two ends of
 * one travel window. Issue #277, the owner: "to enter the dates, we simply have 4 date
 * inoputs, a better experience would be a more advanced calendar component that i can pick
 * multiple dates and visually displays the intervals".
 *
 * Four dates, but only four because two of them are interior cuts rather than free ends:
 *
 *     soonestDeparture                                          latestArrival
 *     D0 ────────────────────────────────────────────────────── A1     the travel window
 *     [── departure window ──] D1
 *                        A0 [── arrival window ──────────────── ]
 *
 * `D0` is both the travel window's left edge and the departure window's left edge; `A1` is
 * both the travel window's right edge and the arrival window's right edge. So the only
 * values a traveller sets beyond the two required dates are `D1` (the latest day they could
 * leave on) and `A0` (the soonest day they could arrive on), and each is a single day inside
 * the span rather than a range of its own.
 *
 * `validation.ts` orders them `D0 <= D1 <= A1` and `D0 <= A0 <= A1`. Nothing orders `D1`
 * against `A0`, so the two windows overlap whenever `D1 >= A0` - and full overlap is the
 * DEFAULT, since both cuts derive to the span's own ends until a traveller narrows them.
 * That is why a stock date-range picker cannot express this and why the calendar draws two
 * rails rather than one selection.
 *
 * Everything here is pure and framework-free, so the picking rules can be tested without a
 * browser. `DateWindowPicker.svelte` owns pixels and nothing else.
 */

import type { IsoCalendarDate } from '$lib/domain';
import { addDays, dayLabel, daysBetween, monthStartOf, monthStartsBetween } from '$lib/flexible-dates';
import { resolveLatestDeparture, resolveSoonestArrival } from './model';

/** The subset of `SearchFormFields` the calendar reads and writes. Deliberately the raw
 * form shape, empty strings and all, so the picker and the four typed inputs are editing
 * one value rather than two copies that drift. */
export interface DateWindowFields {
	soonestDeparture: string;
	/** Empty means "derive from `latestArrival`". */
	latestDepartureOverride: string;
	latestArrival: string;
	/** Empty means "derive from `soonestDeparture`". */
	soonestArrivalOverride: string;
}

/** The same four dates with the two overrides replaced by what they derive to, which is
 * what the calendar paints. An end stays empty only when the required date it derives from
 * is itself still empty. */
export interface ResolvedWindows {
	departFrom: string;
	departTo: string;
	arriveFrom: string;
	arriveTo: string;
}

export function resolveWindows(fields: DateWindowFields): ResolvedWindows {
	return {
		departFrom: fields.soonestDeparture.trim(),
		departTo: resolveLatestDeparture(fields),
		arriveFrom: resolveSoonestArrival(fields),
		arriveTo: fields.latestArrival.trim()
	};
}

/**
 * Where one day sits inside one window's interval. The rail is drawn from this rather than
 * from a pair of booleans so a cell can never render an end cap with no interval behind it:
 * `only` is a one-day window, and there is no way to spell "end without start".
 */
export type RailPosition = 'none' | 'start' | 'middle' | 'end' | 'only';

export interface DayMark {
	date: IsoCalendarDate;
	depart: RailPosition;
	arrive: RailPosition;
	/** Inside the travel window, whatever the two rails say. The days between a narrowed
	 * departure window and a narrowed arrival window are exactly these: days the traveller
	 * is away but neither flying out nor landing. */
	inSpan: boolean;
}

/** ISO dates sort as text, so every comparison here is a string compare and no `Date`
 * object, and therefore no timezone, is involved. `calendar.ts` makes the same call. */
function railAt(date: string, from: string, to: string): RailPosition {
	if (!from || !to || from > to) return 'none';
	if (date < from || date > to) return 'none';
	if (date === from) return date === to ? 'only' : 'start';
	if (date === to) return 'end';
	return 'middle';
}

export function markDay(date: IsoCalendarDate, windows: ResolvedWindows): DayMark {
	return {
		date,
		depart: railAt(date, windows.departFrom, windows.departTo),
		arrive: railAt(date, windows.arriveFrom, windows.arriveTo),
		inSpan: Boolean(
			windows.departFrom &&
				windows.arriveTo &&
				date >= windows.departFrom &&
				date <= windows.arriveTo
		)
	};
}

/** What a day is, in words, for the cell's own accessible name. A calendar that only says
 * "6 March" leaves a screen-reader user to infer the intervals from nothing, which is the
 * one thing this control exists to show. */
export function describeDay(mark: DayMark): string {
	const day = dayLabel(mark.date);
	const canLeave = mark.depart !== 'none';
	const canArrive = mark.arrive !== 'none';
	if (canLeave && canArrive) return `${day}, you could leave and you could arrive`;
	if (canLeave) return `${day}, you could leave`;
	if (canArrive) return `${day}, you could arrive`;
	if (mark.inSpan) return `${day}, away`;
	return day;
}

/**
 * Which of the three values the next tap on the calendar sets. All three are on screen as
 * chips showing their own current value, so the mode is never something the traveller has
 * to remember. Two of them take a single tap; only the travel window needs two.
 */
export type PaintTarget = 'span' | 'latestDeparture' | 'soonestArrival';

export interface PaintState {
	target: PaintTarget;
	/** The first end of a travel window that is still waiting for its second. */
	anchor: string | undefined;
}

export const INITIAL_PAINT: PaintState = { target: 'span', anchor: undefined };

export interface PaintResult {
	fields: DateWindowFields;
	state: PaintState;
}

/** Switching what you are painting abandons a half-drawn travel window rather than letting
 * it complete later against a tap the traveller meant for something else. */
export function armTarget(target: PaintTarget): PaintState {
	return { target, anchor: undefined };
}

/**
 * A cut that no longer falls inside the travel window goes back to deriving from it.
 *
 * This is the one place anything is cleared, and it is deliberate: redrawing the whole
 * window is the traveller saying the old one was wrong, and a "leave by 8 March" left over
 * from a March span is not a value they still hold once the span moves to June. Blank is
 * visible in the UI as "any day", so nothing is silently rewritten to a different date -
 * which is the trap `model.ts` calls out, where "editing one field silently stomps the
 * other and the user cannot tell which value is real".
 */
function dropCutsOutside(
	fields: DateWindowFields,
	from: string,
	/** Undefined between the two taps of a travel window, where the right edge is not
	 * decided yet. A cut after `from` can still turn out to be inside, so only the ones
	 * already behind the new start are dropped. Dropping on the half-drawn one-day span
	 * instead threw away cuts the finished span went on to contain. */
	to: string | undefined
): DateWindowFields {
	const inside = (value: string) => !value || (value >= from && (to === undefined || value <= to));
	return {
		...fields,
		latestDepartureOverride: inside(fields.latestDepartureOverride.trim())
			? fields.latestDepartureOverride
			: '',
		soonestArrivalOverride: inside(fields.soonestArrivalOverride.trim())
			? fields.soonestArrivalOverride
			: ''
	};
}

/**
 * One tap on one day. Returns the next fields and the next paint state; it never mutates
 * what it is given.
 *
 * The travel window takes two taps and then arms "leave by", so the common case - leave
 * somewhere in this week, be back by that day, and I do not care beyond that - is two taps
 * and a stop. A second tap on the day a cut already holds clears that cut back to deriving,
 * which is the same gesture as the "Any day" button beside it.
 */
export function paintDay(
	fields: DateWindowFields,
	state: PaintState,
	date: IsoCalendarDate
): PaintResult {
	if (state.target === 'span') {
		if (state.anchor === undefined) {
			// Both ends, not just the start: one tap is then a complete one-day search rather
			// than a form that looks half filled until a second tap lands.
			return {
				fields: dropCutsOutside(
					{ ...fields, soonestDeparture: date, latestArrival: date },
					date,
					undefined
				),
				state: { target: 'span', anchor: date }
			};
		}
		const [from, to] = state.anchor <= date ? [state.anchor, date] : [date, state.anchor];
		return {
			fields: dropCutsOutside({ ...fields, soonestDeparture: from, latestArrival: to }, from, to),
			state: { target: 'latestDeparture', anchor: undefined }
		};
	}

	if (state.target === 'latestDeparture') {
		// Setting the cut to the span's own end is the same statement as leaving it blank, so
		// store the blank: the field then keeps following the span if the span moves later.
		const cleared = fields.latestDepartureOverride.trim() === date;
		const atSpanEnd = fields.latestArrival.trim() === date;
		return {
			fields: { ...fields, latestDepartureOverride: cleared || atSpanEnd ? '' : date },
			state: { target: 'soonestArrival', anchor: undefined }
		};
	}

	const cleared = fields.soonestArrivalOverride.trim() === date;
	const atSpanStart = fields.soonestDeparture.trim() === date;
	return {
		fields: { ...fields, soonestArrivalOverride: cleared || atSpanStart ? '' : date },
		state: { target: 'soonestArrival', anchor: undefined }
	};
}

/** While a travel window has one end down and is waiting for the other, the calendar paints
 * the range the next tap would produce. Returns the windows to draw, which are the real ones
 * whenever nothing is pending. */
export function previewWindows(
	fields: DateWindowFields,
	state: PaintState,
	hovered: string | undefined
): ResolvedWindows {
	if (state.target !== 'span' || state.anchor === undefined || !hovered) {
		return resolveWindows(fields);
	}
	const [from, to] = state.anchor <= hovered ? [state.anchor, hovered] : [hovered, state.anchor];
	return resolveWindows({ ...fields, soonestDeparture: from, latestArrival: to });
}

/** "6 Mar 2027", "6 to 9 Mar 2027", "28 Feb to 3 Mar 2027". No padded digits, per the
 * owner: "i dont like pad digits, anywhere in ui". */
export function rangeLabel(from: string, to: string): string {
	if (!from && !to) return 'Not set';
	if (!from || !to) return dayLabel(from || to);
	if (from === to) return dayLabel(from);
	const [headDay, headMonth, headYear] = dayLabel(from).split(' ');
	const tail = dayLabel(to);
	const [, tailMonth, tailYear] = tail.split(' ');
	if (headYear !== tailYear) return `${dayLabel(from)} to ${tail}`;
	if (headMonth !== tailMonth) return `${headDay} ${headMonth} to ${tail}`;
	return `${headDay} to ${tail}`;
}

/** "15 days", counting both ends, so a single day reads as "1 day" rather than "0". */
export function spanLength(from: string, to: string): string {
	if (!from || !to) return '';
	const gap = daysBetween(from, to);
	if (gap === undefined || gap < 0) return '';
	return gap === 0 ? '1 day' : `${gap + 1} days`;
}

/**
 * The months the calendar shows: a year from this month, stretched to hold whatever dates
 * the form arrived with. A link shared last spring opens on its own dates rather than on an
 * empty grid the traveller has to scroll for.
 */
export function visibleMonths(today: string, fields: DateWindowFields): IsoCalendarDate[] {
	const dates = [fields.soonestDeparture, fields.latestArrival, fields.latestDepartureOverride, fields.soonestArrivalOverride]
		.map((value) => value.trim())
		.filter(Boolean);
	const first = dates.reduce((earliest, date) => (date < earliest ? date : earliest), today);
	const last = dates.reduce(
		(latest, date) => (date > latest ? date : latest),
		addDays(today, 364)
	);
	return monthStartsBetween(monthStartOf(first), monthStartOf(last));
}
