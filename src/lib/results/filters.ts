/**
 * Issue #23: "Filters over price, total duration, nights, connection city, airline, and
 * free-time length."
 *
 * This is a different mechanism from `SearchQuery.airlinesToAvoid` (docs/prompts/001-initial
 * -brief.md interpretation notes, lines 102-103): "avoid" is a soft, score-only preference
 * that must never remove a result, algorithm/score.ts enforces that. The facets here are
 * the opposite: the traveller pointing at what is already on screen and asking to see only
 * that, which is the whole point of this screen (issue #23's own brief line: "the ui has
 * the search results first, so it is easy to filter out"). Both can be true of the same
 * itinerary at once, greyed out AND still shown, until the traveller narrows past it here.
 *
 * The facets INCLUDE rather than exclude, which is issue #189. The reasoning sits on
 * `chosenConnectionAirports` below. The search form owns the excluding half already.
 *
 * Every numeric bound is EXCLUSIVE-by-omission: `undefined` means "no filter on this axis,"
 * never zero or the current data's minimum, so a filter panel rendered before any results
 * have arrived starts wide open rather than accidentally hiding everything.
 */

import type { IataAirlineCode, IataAirportCode } from '$lib/domain';
import { connectionAirportCode } from './types';
import type { ScoredResult } from './types';

export interface ResultFilters {
	/** Money.minorUnits, compared directly against `itinerary.totalPrice.minorUnits`,
	 * which is safe under the same one-search-one-currency assumption `algorithm/score.ts`
	 * already documents. */
	maxPriceMinorUnits?: number;
	maxTotalDurationMinutes?: number;
	/**
	 * Nights the traveller wants in the stopover. Since issue #224 a card opens at the
	 * SHORTEST length its flights allow, so this is read against what the connection can
	 * REACH, not against the length currently on screen: a London card showing one night
	 * with a three-night pairing behind it is exactly what somebody asking for three nights
	 * is looking for, and hiding it would answer their question with silence.
	 *
	 * `+page.svelte` also seeds each card's shown length from this, so setting it to three
	 * makes the cards show three-night trips rather than leaving the traveller to press +
	 * on every one of them.
	 */
	minNights?: number;
	minFreeTimeMinutes?: number;
	/**
	 * The connection cities the traveller asked to see. EMPTY MEANS ALL, so a connection
	 * city that streams in after the panel is first drawn is visible by default rather than
	 * silently hidden for not being in a list the traveller never saw.
	 *
	 * This was an exclude-list until issue #189. Every chip in the rail is labelled with its
	 * own count, `London LGW (1)`, and under exclusion clicking it left the OTHER results on
	 * screen: the number on the label was one you had to invert to be right. It also
	 * duplicated the search form's own `forbiddenConnectionAirports` field, and it could not
	 * say "only show me LGW", which is the whole question a page of four options raises.
	 * Measured before and after in tools/probe-filter-chips.mjs.
	 *
	 * Once the traveller HAS narrowed to a city, a result arriving later through a different
	 * one is correctly hidden, and its chip still appears in the rail carrying its own count,
	 * so the choice stays visible and one click wide.
	 */
	chosenConnectionAirports: ReadonlySet<IataAirportCode>;
	/**
	 * The airlines the traveller asked to see, empty meaning all, same as above.
	 *
	 * An itinerary has two carriers, and this matches on EITHER leg, because that is what
	 * makes the chip's count true: `deriveFilterOptions` counts an itinerary under both of
	 * its carriers, so `FR (1)` promises the one itinerary that flies FR somewhere in it.
	 * Requiring both legs would answer that label with zero.
	 *
	 * Still orthogonal to `SearchQuery.airlinesToAvoid` (see this file's header): that one is
	 * a soft score-only preference that must never remove a result, this one is the traveller
	 * pointing at a carrier on the results screen and saying show me that.
	 */
	chosenAirlines: ReadonlySet<IataAirlineCode>;
}

export function emptyFilters(): ResultFilters {
	return { chosenConnectionAirports: new Set(), chosenAirlines: new Set() };
}

/** True if no filter is currently narrowing the list, for a "clear filters" control that
 * disables itself, and for tests to assert the default hides nothing. */
export function isEmptyFilters(filters: ResultFilters): boolean {
	return (
		filters.maxPriceMinorUnits === undefined &&
		filters.maxTotalDurationMinutes === undefined &&
		filters.minNights === undefined &&
		filters.minFreeTimeMinutes === undefined &&
		filters.chosenConnectionAirports.size === 0 &&
		filters.chosenAirlines.size === 0
	);
}

/** The most nights this connection can offer, whatever length its card currently shows.
 * `stopover.options` is ascending, so the last rung is the longest. Falling back to the
 * shown itinerary keeps this honest for any caller building a `ScoredResult` by hand. */
function longestStopoverNights(result: ScoredResult): number {
	return result.stopover.options.at(-1)?.nights ?? result.itinerary.nightsInConnection;
}

function passesFilters(result: ScoredResult, filters: ResultFilters): boolean {
	const { itinerary } = result;

	if (
		filters.maxPriceMinorUnits !== undefined &&
		itinerary.totalPrice.minorUnits > filters.maxPriceMinorUnits
	) {
		return false;
	}
	if (
		filters.maxTotalDurationMinutes !== undefined &&
		itinerary.times.total > filters.maxTotalDurationMinutes
	) {
		return false;
	}
	if (filters.minNights !== undefined && longestStopoverNights(result) < filters.minNights) {
		return false;
	}
	if (
		filters.minFreeTimeMinutes !== undefined &&
		itinerary.freeTime.duration < filters.minFreeTimeMinutes
	) {
		return false;
	}
	if (
		filters.chosenConnectionAirports.size > 0 &&
		!filters.chosenConnectionAirports.has(connectionAirportCode(itinerary))
	) {
		return false;
	}
	if (
		filters.chosenAirlines.size > 0 &&
		!filters.chosenAirlines.has(itinerary.outboundFlight.carrier.iataCode) &&
		!filters.chosenAirlines.has(itinerary.onwardFlight.carrier.iataCode)
	) {
		return false;
	}
	return true;
}

export function applyFilters(
	results: readonly ScoredResult[],
	filters: ResultFilters
): ScoredResult[] {
	return results.filter((result) => passesFilters(result, filters));
}

/** One filterable value plus how many current results carry it, a filter panel shows
 * counts so "Ryanair (12)" reads as a real choice, not a guess. */
export interface FilterOptionCount<T> {
	value: T;
	count: number;
}

export interface FilterBounds {
	min: number;
	max: number;
}

/** Everything a filter panel needs to draw its own controls against the results seen SO
 * FAR, bounds and option lists grow as more results stream in, which is the panel
 * offering more choice over time, not the same instability `stream-order.ts` guards
 * against for the list itself (a filter control gaining an option is not a card moving
 * under anyone's finger). */
export interface FilterOptions {
	connectionAirports: FilterOptionCount<IataAirportCode>[];
	airlines: FilterOptionCount<IataAirlineCode>[];
	priceRangeMinorUnits?: FilterBounds;
	totalDurationRangeMinutes?: FilterBounds;
	nightsRange?: FilterBounds;
	freeTimeRangeMinutes?: FilterBounds;
}

function bumpCount<T>(counts: Map<T, number>, value: T): void {
	counts.set(value, (counts.get(value) ?? 0) + 1);
}

function toSortedOptionList<T extends string>(counts: Map<T, number>): FilterOptionCount<T>[] {
	return Array.from(counts.entries())
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function extendBounds(current: FilterBounds | undefined, value: number): FilterBounds {
	if (!current) return { min: value, max: value };
	return { min: Math.min(current.min, value), max: Math.max(current.max, value) };
}

/** Derives every option list and numeric bound in one pass over `results`, rather than
 * the filter panel re-scanning the same array once per control. */
export function deriveFilterOptions(results: readonly ScoredResult[]): FilterOptions {
	const connectionCounts = new Map<IataAirportCode, number>();
	const airlineCounts = new Map<IataAirlineCode, number>();
	let priceRange: FilterBounds | undefined;
	let durationRange: FilterBounds | undefined;
	let nightsRange: FilterBounds | undefined;
	let freeTimeRange: FilterBounds | undefined;

	for (const result of results) {
		const { itinerary } = result;
		bumpCount(connectionCounts, connectionAirportCode(itinerary));
		bumpCount(airlineCounts, itinerary.outboundFlight.carrier.iataCode);
		bumpCount(airlineCounts, itinerary.onwardFlight.carrier.iataCode);
		priceRange = extendBounds(priceRange, itinerary.totalPrice.minorUnits);
		durationRange = extendBounds(durationRange, itinerary.times.total);
		// Every length these connections can reach, not only the shortest one each card
		// happens to open on (issue #224). Otherwise a list of one-night cards would draw a
		// slider that runs from 1 to 1, and the traveller could no longer ask for the
		// three-night trips sitting behind those same cards.
		for (const option of result.stopover.options) {
			nightsRange = extendBounds(nightsRange, option.nights);
		}
		freeTimeRange = extendBounds(freeTimeRange, itinerary.freeTime.duration);
	}

	return {
		connectionAirports: toSortedOptionList(connectionCounts),
		airlines: toSortedOptionList(airlineCounts),
		priceRangeMinorUnits: priceRange,
		totalDurationRangeMinutes: durationRange,
		nightsRange,
		freeTimeRangeMinutes: freeTimeRange
	};
}
