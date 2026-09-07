/**
 * What a saved trip says on a row, and what its price log says about where the price went.
 *
 * Pure, so both screens read the same sentence and the arithmetic behind a trend arrow is
 * testable without mounting anything. `search-history/summary.ts` plays the same part for
 * the search history, and `formatDateRange` is borrowed from it rather than rewritten so
 * the two lists spell a date range the same way.
 */

import type { IsoCurrencyCode, ItineraryTransferLeg, Money } from '$lib/domain';
import { formatMoney } from '$lib/format';
import { formatDateRange, formatTravellers } from '$lib/search-history/summary';
import type { PriceObservation, SavedItinerary, SavedTrip } from './types';

export interface SavedSummary {
	/** The three codes on their own, because the screen draws the arrows between them and a
	 * screen reader must never be handed a glyph to read out loud. Same split
	 * `RecentSearches` makes with `SearchSummary`. */
	originAirport: string;
	connectionAirport: string;
	destinationAirport: string;
	/** "14 to 16 Oct 2026": the trip's own dates, off the flights, not the search window
	 * that found it. A saved trip is a specific pair of flights on specific days. */
	dates: string;
	/** "2 nights in Vienna", or "No night, airport connection" for an airside trip. */
	stopover: string;
	travellers: string;
	/** The whole thing on one line, for an aria-label. */
	label: string;
}

/** The calendar date part of a wall-clock local time, which is what `formatDateRange`
 * reads. Sliced rather than parsed: `IsoLocalDateTimeString` opens with `YYYY-MM-DD` by
 * definition, and turning it into a `Date` first is how a local date becomes yesterday. */
function calendarDate(local: string): string {
	return local.slice(0, 10);
}

export function stopoverPhrase(trip: SavedTrip): string {
	if (trip.nightsInConnection === 0) return `No night, ${trip.connection.city} airport only`;
	const nights = trip.nightsInConnection === 1 ? '1 night' : `${trip.nightsInConnection} nights`;
	return `${nights} in ${trip.connection.city}`;
}

export function summarizeSavedItinerary(entry: SavedItinerary): SavedSummary {
	const { trip } = entry;
	const dates = formatDateRange(
		calendarDate(trip.outboundFlight.departure.local),
		calendarDate(trip.onwardFlight.arrival.local)
	);
	const travellers = formatTravellers(trip.travellers);
	const stopover = stopoverPhrase(trip);
	return {
		originAirport: trip.origin.airport,
		connectionAirport: trip.connection.airport,
		destinationAirport: trip.destination.airport,
		dates,
		stopover,
		travellers,
		label: `${trip.origin.airport} to ${trip.destination.airport} via ${trip.connection.airport}, ${dates}, ${stopover}, ${travellers}`
	};
}

/**
 * Where the price went between the first observation and the newest.
 *
 * `single` is its own case rather than a delta of zero, because one observation is not a
 * trend and this app does not dress a small sample as a large one. `results/price-band.ts`
 * is the precedent and states the rule at length: a confident-looking bar built on three
 * data points is the thing to avoid, and the sample size is a value the caller has to put
 * on screen rather than a detail it may drop.
 *
 * `incomparable` is the other honest refusal. Two totals in different currencies cannot be
 * subtracted without a rate this module does not have, and a converted delta would be a
 * number no provider ever quoted.
 */
export type PriceTrend =
	| { kind: 'none' }
	| { kind: 'single'; latest: PriceObservation }
	| {
			kind: 'compared';
			first: PriceObservation;
			latest: PriceObservation;
			/** Signed, latest minus first. Zero means the price has not moved, which
			 * `formatMoneyDelta` already prints as "same price". */
			deltaMinorUnits: number;
			currency: IsoCurrencyCode;
	  }
	| { kind: 'incomparable'; first: PriceObservation; latest: PriceObservation };

export function priceTrend(prices: readonly PriceObservation[]): PriceTrend {
	const first = prices[0];
	const latest = prices.at(-1);
	if (!first || !latest) return { kind: 'none' };
	if (prices.length === 1) return { kind: 'single', latest };
	if (first.total.currency !== latest.total.currency) return { kind: 'incomparable', first, latest };
	return {
		kind: 'compared',
		first,
		latest,
		deltaMinorUnits: latest.total.minorUnits - first.total.minorUnits,
		currency: latest.total.currency
	};
}

/** What each ground leg is called, in the words the results receipt already uses
 * (`components/itinerary-metrics.ts`'s own ground rows, which the owner named himself). A
 * saved trip and the card it came from must not call one leg two things. */
export const GROUND_LEG_LABELS: Record<ItineraryTransferLeg, string> = {
	transferToOriginAirport: 'Ride from origin',
	transferToHotel: 'Ride to hotel',
	transferToConnectionAirport: 'Ride from hotel',
	transferToDestinationLocation: 'Ride to destination'
};

export type TrendDirection = 'cheaper' | 'dearer' | 'level' | 'single' | 'incomparable';

/**
 * What a screen says about the trend, in the two lengths the two screens have room for.
 *
 * The words carry the meaning and the colour only repeats it, so the fall in a price is
 * legible to somebody who cannot tell the green from the red. Same rule the provider
 * status strip follows, and the reason `is-deprioritized` in `app.css` is a colour swap
 * rather than an opacity trick.
 */
export interface TrendNote {
	direction: TrendDirection;
	/** For a row in a list. */
	short: string;
	/** For the trip's own card, where there is room to name what it is compared against. */
	long: string;
}

export function trendNote(trend: PriceTrend): TrendNote | undefined {
	switch (trend.kind) {
		case 'none':
			return undefined;
		case 'single':
			return {
				direction: 'single',
				short: 'One price so far',
				long: 'One price so far. Open the search again and the next one lands here.'
			};
		case 'incomparable':
			return {
				direction: 'incomparable',
				short: 'Priced in another currency',
				long: `Saved in ${trend.first.total.currency} and priced in ${trend.latest.total.currency} now, so these two numbers cannot be subtracted.`
			};
		case 'compared': {
			if (trend.deltaMinorUnits === 0) {
				return { direction: 'level', short: 'No change', long: 'The same as when you saved it.' };
			}
			const amount = formatMoney({
				minorUnits: Math.abs(trend.deltaMinorUnits),
				currency: trend.currency
			});
			const direction = trend.deltaMinorUnits < 0 ? 'cheaper' : 'dearer';
			return {
				direction,
				short: `${amount} ${direction}`,
				long: `${amount} ${direction} than when you saved it.`
			};
		}
	}
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "14 Oct 2026": the day this browser saw a price, on this browser's own clock.
 *
 * The one time in this feature that is NOT a wall clock somewhere else. Every other time
 * here belongs to an airport and carries its zone; this one is the moment the traveller was
 * sitting in front of the app, so their own zone is the right and only answer. Which is why
 * it reads off `Date`'s local getters rather than `toISOString`, whose UTC day is a
 * different day for anybody looking after dark in Europe or before breakfast in the
 * Americas.
 *
 * Built from a name table rather than `Intl`, the same choice `format.ts` makes and for the
 * same reason: Node's own `en-GB` abbreviates September as "Sept", so the month would be
 * spelled one way in a test and another on a phone.
 */
export function formatObservedDate(observedAt: number): string {
	const when = new Date(observedAt);
	return `${when.getDate()} ${MONTHS[when.getMonth()]} ${when.getFullYear()}`;
}

/** One line of the receipt, with the money absent when nobody priced that part. The screen
 * prints the absence rather than a zero, which is the whole reason the field is optional in
 * the stored shape. */
export interface ObservationPart {
	id: 'flights' | 'bed' | 'ground';
	label: string;
	money?: Money;
}

/** Always three rows, in the order the money is spent. A part with no number still gets its
 * row, because "we could not price the ride" is a fact about this trip and a missing row
 * reads as a trip with no ground legs at all (issue #249 made the same argument about the
 * results receipt). */
export function observationParts(observation: PriceObservation): ObservationPart[] {
	return [
		{ id: 'flights', label: 'Flights', money: observation.flights },
		{ id: 'bed', label: 'Bed', money: observation.bed },
		{ id: 'ground', label: 'Ground', money: observation.ground }
	];
}

export interface SparklinePoint {
	x: number;
	y: number;
	observation: PriceObservation;
}

export interface Sparkline {
	/** `x,y x,y ...`, ready for a `<polyline points>`. */
	points: string;
	plotted: SparklinePoint[];
	low: Money;
	high: Money;
}

/**
 * The totals as a line inside a box, or nothing when there is no line to draw.
 *
 * Nothing means one plottable point or none, and the caller says so in words instead. Two
 * points is the floor, and it is a low one on purpose: unlike `price-band.ts`, which infers
 * a typical price and therefore needs fourteen days of them, this claims only "here is what
 * we saw, when we saw it". Every point on it is a price this browser was actually quoted.
 *
 * X is time, not row number, so a month of not looking reads as a month. Y is inverted for
 * SVG, where the origin is the top left, and a log whose totals are all equal draws flat
 * across the middle rather than dividing by a zero range.
 *
 * Observations in another currency are left out rather than converted or scaled beside the
 * rest: an axis carrying two currencies is a line that means nothing at either end.
 */
export function sparkline(
	prices: readonly PriceObservation[],
	box: { width: number; height: number }
): Sparkline | undefined {
	const latest = prices.at(-1);
	if (!latest) return undefined;
	const currency = latest.total.currency;
	const usable = prices.filter((price) => price.total.currency === currency);
	if (usable.length < 2) return undefined;

	const amounts = usable.map((price) => price.total.minorUnits);
	const lowest = Math.min(...amounts);
	const highest = Math.max(...amounts);
	const span = highest - lowest;

	const times = usable.map((price) => price.observedAt);
	const start = Math.min(...times);
	const timeSpan = Math.max(...times) - start;

	const plotted = usable.map((observation, index) => ({
		x:
			timeSpan === 0
				? (box.width * index) / (usable.length - 1)
				: (box.width * (observation.observedAt - start)) / timeSpan,
		y:
			span === 0
				? box.height / 2
				: box.height - (box.height * (observation.total.minorUnits - lowest)) / span,
		observation
	}));

	return {
		points: plotted.map((point) => `${round(point.x)},${round(point.y)}`).join(' '),
		plotted,
		low: { minorUnits: lowest, currency },
		high: { minorUnits: highest, currency }
	};
}

/** Two decimals is finer than any screen this draws on, and it keeps the `points`
 * attribute short enough to read in devtools. */
function round(value: number): number {
	return Math.round(value * 100) / 100;
}
