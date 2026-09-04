/**
 * Issue #71's arithmetic: turn two legs' worth of daily fares into "which week should I
 * go", without ever filling in a day nobody priced.
 *
 * Pure. No cache, no fetch, no clock. That is the point of keeping it here rather than in
 * the page: the acceptance criterion is that narrowing, widening or shifting the window
 * costs zero requests, and a function that cannot reach the network cannot break it.
 * `flexible-dates.test.ts` asserts the same thing from the outside with a counting fetch.
 *
 * The trip this app sells is one-way with a deliberate gap in the middle: fly origin ->
 * stopover, sleep there for a few nights, fly stopover -> destination. So a candidate is a
 * PAIR of departure dates, one on each leg, and the stopover length is counted from the
 * outbound's ARRIVAL date to the onward's DEPARTURE date. Counting from the outbound's
 * departure date instead would quietly lose a night every time a flight lands after
 * midnight, which is the exact failure AGENTS.md's timezone section is about.
 */

import type { IsoCalendarDate } from '../domain';
import { addDays, daysBetween, isoWeekStart } from './calendar';
import type { DayFare, LegFares, MonthCoverage } from './types';

/** One complete, priced way to make the trip: a real fare on each leg, and the nights that
 * fall between them. Both halves are real observations; nothing here is interpolated. */
export interface TripWindow {
	outbound: DayFare;
	onward: DayFare;
	/** Calendar nights in the stopover city: outbound arrival date to onward departure
	 * date. Zero means the same-day connection this app exists to avoid, which is why the
	 * default `minNights` is 1. */
	nights: number;
	/** One adult, both legs, in `LegFares.currency`'s minor units. No stay, no transfers.
	 * see `flexibleDatesDisclaimer` for why this view refuses to guess at those. */
	totalMinorUnits: number;
	/** The older of the two fares' `observedAt`. A pair is only as current as its stalest
	 * half, and the UI prints this rather than the newer, flattering one. */
	oldestObservedAt: number;
}

export interface WindowConstraints {
	/** Inclusive lower bound on stopover nights. */
	minNights: number;
	/** Inclusive upper bound. */
	maxNights: number;
	/** Inclusive earliest outbound departure date. Omitted means "no lower bound". */
	from?: IsoCalendarDate;
	/** Inclusive latest outbound departure date. */
	to?: IsoCalendarDate;
}

/**
 * Every priced pair that satisfies the constraints, cheapest first.
 *
 * Deliberately O(outbound days x nights range) rather than O(days squared): the onward
 * fares are indexed by date once, and each outbound day only looks at the dates its allowed
 * stopover lengths can reach. A full year against a 1-14 night range is ~5,000 lookups,
 * which is nothing, and it stays nothing if a future source ever fills every day.
 */
export function tripWindows(
	outboundFares: readonly DayFare[],
	onwardFares: readonly DayFare[],
	constraints: WindowConstraints
): TripWindow[] {
	const minNights = Math.max(0, Math.trunc(constraints.minNights));
	const maxNights = Math.max(minNights, Math.trunc(constraints.maxNights));

	const onwardByDate = new Map<IsoCalendarDate, DayFare>();
	for (const fare of onwardFares) {
		const existing = onwardByDate.get(fare.departureDate);
		if (!existing || fare.minorUnits < existing.minorUnits) onwardByDate.set(fare.departureDate, fare);
	}

	const windows: TripWindow[] = [];
	for (const outbound of outboundFares) {
		if (constraints.from !== undefined && outbound.departureDate < constraints.from) continue;
		if (constraints.to !== undefined && outbound.departureDate > constraints.to) continue;

		for (let nights = minNights; nights <= maxNights; nights++) {
			const onward = onwardByDate.get(addDays(outbound.arrivalDate, nights));
			if (!onward) continue;
			windows.push({
				outbound,
				onward,
				nights,
				totalMinorUnits: outbound.minorUnits + onward.minorUnits,
				oldestObservedAt: Math.min(outbound.observedAt, onward.observedAt)
			});
		}
	}

	return windows.sort(
		(a, b) =>
			a.totalMinorUnits - b.totalMinorUnits ||
			a.outbound.departureDate.localeCompare(b.outbound.departureDate) ||
			a.nights - b.nights
	);
}

/** One ISO week, and the cheapest way found to leave during it. */
export interface RankedWeek {
	/** Monday. */
	weekStart: IsoCalendarDate;
	/** Sunday. */
	weekEnd: IsoCalendarDate;
	best: TripWindow;
	/** How many distinct outbound departure dates in this week produced a complete pair.
	 * Printed on the card: "cheapest of 3 priced departures" is an honest way to say a week
	 * with one lucky day is not the same evidence as a week with six. */
	pricedDepartures: number;
	/** Every pair found in the week, cheapest first, so a card can offer the runner-up
	 * stopover lengths without a second pass. */
	windows: TripWindow[];
}

/**
 * The weeks, cheapest first. A week only appears when at least one complete pair falls in
 * it: a week with fares on one leg and nothing on the other is not a cheap week, it is an
 * unknown one, and it belongs in the coverage report rather than the ranking.
 */
export function rankWeeks(
	outboundFares: readonly DayFare[],
	onwardFares: readonly DayFare[],
	constraints: WindowConstraints
): RankedWeek[] {
	const byWeek = new Map<IsoCalendarDate, TripWindow[]>();
	for (const window of tripWindows(outboundFares, onwardFares, constraints)) {
		const weekStart = isoWeekStart(window.outbound.departureDate);
		const bucket = byWeek.get(weekStart);
		if (bucket) bucket.push(window);
		else byWeek.set(weekStart, [window]);
	}

	const weeks: RankedWeek[] = [];
	for (const [weekStart, windows] of byWeek) {
		// `tripWindows` already sorted globally by price, and a stable partition of a sorted
		// list stays sorted, so `windows[0]` is this week's cheapest without re-sorting.
		weeks.push({
			weekStart,
			weekEnd: addDays(weekStart, 6),
			best: windows[0],
			pricedDepartures: new Set(windows.map((window) => window.outbound.departureDate)).size,
			windows
		});
	}

	return weeks.sort(
		(a, b) => a.best.totalMinorUnits - b.best.totalMinorUnits || a.weekStart.localeCompare(b.weekStart)
	);
}

/**
 * The cheapest complete pair per outbound departure date, for the calendar grid. One entry
 * per day the trip can actually be made on. A day with an outbound fare but no reachable
 * onward fare is absent, because "we know the outbound costs 20" is not an answer to "what
 * does this trip cost if I leave on the 12th".
 */
export function cheapestByDeparture(
	outboundFares: readonly DayFare[],
	onwardFares: readonly DayFare[],
	constraints: WindowConstraints
): Map<IsoCalendarDate, TripWindow> {
	const byDate = new Map<IsoCalendarDate, TripWindow>();
	for (const window of tripWindows(outboundFares, onwardFares, constraints)) {
		const existing = byDate.get(window.outbound.departureDate);
		if (!existing || window.totalMinorUnits < existing.totalMinorUnits) {
			byDate.set(window.outbound.departureDate, window);
		}
	}
	return byDate;
}

/**
 * What the view can and cannot answer, in numbers a sentence can be built from. Every field
 * is counted from the two legs' own coverage, never asserted.
 */
export interface CoverageReport {
	/** Days in the window with a complete, priced pair. */
	pricedTripDays: number;
	/** Days in the window at all, meaning the window the caller actually asked about, not the
	 * whole calendar months it touches. Counting whole months would put yesterday and next
	 * October's tail into the denominator and quietly understate coverage. */
	totalDays: number;
	/** Month starts where neither leg knows anything, the honest "nothing at all for
	 * November" list. */
	unknownMonths: IsoCalendarDate[];
	/** Month starts where at least one leg has a price. */
	knownMonths: IsoCalendarDate[];
	/** Epoch millis of the oldest and newest observation behind any priced day, or
	 * `undefined` when there are none. The UI turns these into "cached between the 2nd and
	 * the 14th". */
	oldestObservedAt?: number;
	newestObservedAt?: number;
	/** Every provider that contributed a fare, so the view can name its sources instead of
	 * saying "cached data". */
	providerIds: string[];
}

export function coverageReport(
	outbound: LegFares,
	onward: LegFares,
	tripDays: ReadonlyMap<IsoCalendarDate, TripWindow>,
	/** The date window the view is actually about. Omitted, the denominator falls back to
	 * every day of every calendar month the legs cover, which is only right when the window
	 * happens to start on the 1st and end on a month's last day. */
	window?: { from: IsoCalendarDate; to: IsoCalendarDate }
): CoverageReport {
	const knownMonths: IsoCalendarDate[] = [];
	const unknownMonths: IsoCalendarDate[] = [];
	let monthDays = 0;

	const onwardByMonth = new Map<IsoCalendarDate, MonthCoverage>();
	for (const month of onward.months) onwardByMonth.set(month.monthStart, month);

	for (const month of outbound.months) {
		monthDays += month.pricedDays + month.blankDays + month.unknownDays;
		const other = onwardByMonth.get(month.monthStart);
		const anythingKnown = month.pricedDays > 0 || (other?.pricedDays ?? 0) > 0;
		if (anythingKnown) knownMonths.push(month.monthStart);
		else unknownMonths.push(month.monthStart);
	}

	let oldestObservedAt: number | undefined;
	let newestObservedAt: number | undefined;
	const providerIds = new Set<string>();
	for (const window of tripDays.values()) {
		for (const fare of [window.outbound, window.onward]) {
			providerIds.add(fare.providerId);
			if (oldestObservedAt === undefined || fare.observedAt < oldestObservedAt) {
				oldestObservedAt = fare.observedAt;
			}
			if (newestObservedAt === undefined || fare.observedAt > newestObservedAt) {
				newestObservedAt = fare.observedAt;
			}
		}
	}

	return {
		pricedTripDays: tripDays.size,
		totalDays: window ? inclusiveDayCount(window.from, window.to) : monthDays,
		unknownMonths,
		knownMonths,
		oldestObservedAt,
		newestObservedAt,
		providerIds: [...providerIds].sort()
	};
}

/**
 * The one sentence this whole view must never stop saying. Kept here, next to the maths it
 * qualifies, rather than typed into a component, so it cannot drift away from what the
 * numbers actually mean.
 */
export const FLEXIBLE_DATES_DISCLAIMER =
	'These are the cheapest fares each source once reported for a single day, for one adult, ' +
	'flights only. They say which days are worth pricing properly. They are not a quote, and ' +
	'confirming a real itinerary still runs a real search.';

/** Days the grid can colour, split into bands, so a cell's shade means a rank rather than an
 * absolute price nobody can calibrate against. Returns `undefined` when there is nothing to
 * band, which the grid renders as "no data" rather than as the cheapest band. */
export function priceBands(
	windows: ReadonlyMap<IsoCalendarDate, TripWindow>,
	bandCount = 4
): { thresholds: number[]; cheapestMinorUnits: number; dearestMinorUnits: number } | undefined {
	const totals = [...windows.values()].map((window) => window.totalMinorUnits).sort((a, b) => a - b);
	if (totals.length === 0) return undefined;

	// Quantiles, not equal price intervals: one outlier fare would otherwise push every
	// ordinary day into the cheapest band and make the whole grid one colour.
	const thresholds: number[] = [];
	for (let i = 1; i < bandCount; i++) {
		thresholds.push(totals[Math.min(totals.length - 1, Math.floor((totals.length * i) / bandCount))]);
	}
	return { thresholds, cheapestMinorUnits: totals[0], dearestMinorUnits: totals[totals.length - 1] };
}

/** Which band a total falls in, 0 being the cheapest. */
export function bandOf(totalMinorUnits: number, thresholds: readonly number[]): number {
	let band = 0;
	while (band < thresholds.length && totalMinorUnits >= thresholds[band]) band++;
	return band;
}

/** Days between two dates as a count of calendar days, exported for the view's own copy
 * ("62 of 366 days"). Falls back to 0 rather than NaN on a malformed bound. */
export function inclusiveDayCount(from: IsoCalendarDate, to: IsoCalendarDate): number {
	const gap = daysBetween(from, to);
	return gap === undefined ? 0 : Math.max(0, gap + 1);
}
