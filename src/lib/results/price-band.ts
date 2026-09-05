/**
 * Issue #232: where this trip's fare sits among the fares this browser has already seen.
 *
 * The owner, having seen it on Google Flights: "€249 is typical for Economy / The least
 * expensive flights for similar trips to Rome usually cost between €215–260."
 *
 * Google can say "typical" because it holds years of global booking data. We hold what this
 * browser happened to fetch, and the two are not the same claim. Everything in this file is
 * built so the second claim cannot be dressed up as the first: the sample size, the dates it
 * covers and the fact that it is one browser's own history are all values the caller has to
 * put on screen, and the band refuses to exist at all below a floor.
 *
 * ## The three judgements, and the arguments for them
 *
 * **How much data is enough: 14 priced departure dates.** Two full weeks, so every weekday
 * has been seen at least twice and the band is not a picture of one Tuesday. The mechanical
 * floor is lower and worth stating too: below ten observations the tenth percentile IS the
 * minimum, so a band drawn as "p10 to p90" would claim to exclude outliers while excluding
 * none, which is the "confident-looking bar built on three data points" the issue warns
 * about. Fourteen clears both. `tooLittleHistory` is a value rather than a `null`, so a
 * caller has to decide what to do with it rather than discovering an absence.
 *
 * **What "this route" means: the exact origin and destination airports, pooled across every
 * stopover.** Not the city pair, because BCN and GRO are different journeys and blurring
 * them is the "similarity model" the issue rejects. Not one stopover at a time either: the
 * traveller's question is "is this a good price for getting from here to there", the
 * stopover is the variable this whole app exists to change, and a per-stopover band would
 * rest on the handful of days that one pair happens to have on both legs. Pooling also
 * means every card on a results page is marked against ONE band with one sample size, so
 * the page makes its comparison claim once instead of eight times with eight different
 * denominators.
 *
 * **What is compared: one adult, flights only, both legs.** The ledger holds one-adult
 * fares and nothing else (`flexible-dates/types.ts`), so this is the only like-for-like
 * figure available. It is also the honest comparable, since a bed is not what Google is
 * banding either. An itinerary whose fares are `'party-total'` (Skyscanner's shape) has no
 * one-adult figure at all and gets no marker rather than a divided-down invention.
 *
 * Pure, and deliberately so: the collection half lives in `price-band-source.ts` and is the
 * only part that touches IndexedDB. Everything here can be tested with two arrays.
 */

import type { IataAirportCode, IsoCalendarDate, IsoCurrencyCode, Itinerary, Money } from '$lib/domain';
import { cheapestByDeparture, monthLabel, monthStartOf, shortMonthLabel } from '$lib/flexible-dates';
import type { DayFare } from '$lib/flexible-dates';

/**
 * Departure dates that must be priced end to end before a band is drawn at all.
 *
 * Fourteen is two full weeks. See the file header for why that number and not the
 * mechanical minimum of ten.
 */
export const MIN_PRICED_DEPARTURES = 14;

/** How the band's track is cut for the eye: three equal steps across the drawn range. */
export const BAND_ZONES = 3;

/** One stopover's two legs, as the ledger knows them. */
export interface StopoverLegFares {
	via: IataAirportCode;
	outbound: readonly DayFare[];
	onward: readonly DayFare[];
}

/** The cheapest complete trip found for one departure date, across every stopover. */
export interface PricedDeparture {
	departureDate: IsoCalendarDate;
	/** One adult, both legs, no bed, no ground. Minor units of the band's currency. */
	minorUnits: number;
	via: IataAirportCode;
	/** The older of the two fares behind it. A pair is only as current as its stalest half. */
	observedAt: number;
	/** The adapters behind the two legs. Carried on the winning pair rather than collected
	 * as the search runs, because a stopover that was cheapest for a while and then lost
	 * the day contributed nothing to the band and must not be named as a source of it. */
	providerIds: readonly string[];
}

export interface PriceHistory {
	kind: 'band';
	currency: IsoCurrencyCode;
	/** Every priced departure, cheapest first. */
	departures: readonly PricedDeparture[];
	/** Tenth percentile of `departures`, the cheap end of the drawn track. */
	lowMinorUnits: number;
	/** Ninetieth percentile, the dear end. */
	highMinorUnits: number;
	earliestDeparture: IsoCalendarDate;
	latestDeparture: IsoCalendarDate;
	/** When the stalest and freshest fare behind this band came off a provider's wire. */
	oldestObservedAt: number;
	newestObservedAt: number;
	/** Every adapter that contributed a fare, sorted, so the screen can name its sources. */
	providerIds: readonly string[];
}

/** Not enough history to say anything, and the numbers to say so with. */
export interface TooLittleHistory {
	kind: 'too-little-history';
	pricedDepartures: number;
	needed: number;
}

export type PriceBand = PriceHistory | TooLittleHistory;

export interface BandConstraints {
	currency: IsoCurrencyCode;
	/** Nights in the stopover, inclusive. Set from the search's own window so the band
	 * covers the trips this search could return and no others: a card that is a same-day
	 * flight change must not be ranked against a set that excludes its own shape. */
	minNights: number;
	maxNights: number;
}

/** The value at a quantile of an ascending list, by the same index rule `flexible-dates`
 * uses for its calendar bands, so the two never disagree about what a quantile is. */
function quantile(ascending: readonly number[], fraction: number): number {
	const index = Math.min(ascending.length - 1, Math.floor(ascending.length * fraction));
	return ascending[Math.max(0, index)];
}

/**
 * The band, or the reason there isn't one.
 *
 * Reduced to one entry per departure date on purpose. The unit a traveller reasons in is a
 * day ("would I have paid less if I'd gone on the 12th"), and without the reduction a
 * stopover with dense coverage would supply most of the distribution and the band would
 * describe that city rather than the route.
 */
export function buildPriceBand(
	legsByStopover: readonly StopoverLegFares[],
	constraints: BandConstraints
): PriceBand {
	const windowConstraints = { minNights: constraints.minNights, maxNights: constraints.maxNights };
	const cheapestPerDay = new Map<IsoCalendarDate, PricedDeparture>();

	for (const legs of legsByStopover) {
		for (const [departureDate, window] of cheapestByDeparture(legs.outbound, legs.onward, windowConstraints)) {
			const existing = cheapestPerDay.get(departureDate);
			if (existing && existing.minorUnits <= window.totalMinorUnits) continue;
			cheapestPerDay.set(departureDate, {
				departureDate,
				minorUnits: window.totalMinorUnits,
				via: legs.via,
				observedAt: window.oldestObservedAt,
				providerIds: [...new Set([window.outbound.providerId, window.onward.providerId])]
			});
		}
	}

	if (cheapestPerDay.size < MIN_PRICED_DEPARTURES) {
		return {
			kind: 'too-little-history',
			pricedDepartures: cheapestPerDay.size,
			needed: MIN_PRICED_DEPARTURES
		};
	}

	const departures = [...cheapestPerDay.values()].sort((a, b) => a.minorUnits - b.minorUnits);
	const totals = departures.map((departure) => departure.minorUnits);
	const dates = [...cheapestPerDay.keys()].sort();
	const observedAts = departures.map((departure) => departure.observedAt);

	return {
		kind: 'band',
		currency: constraints.currency,
		departures,
		lowMinorUnits: quantile(totals, 0.1),
		highMinorUnits: quantile(totals, 0.9),
		earliestDeparture: dates[0],
		latestDeparture: dates[dates.length - 1],
		oldestObservedAt: Math.min(...observedAts),
		newestObservedAt: Math.max(...observedAts),
		providerIds: [...new Set(departures.flatMap((departure) => departure.providerIds))].sort()
	};
}

export interface BandPosition {
	/** 0 at the cheap end of the drawn track, 1 at the dear end, clamped to both. */
	fraction: number;
	/** How many of the priced departures cost more than this trip. */
	cheaperThan: number;
	outOf: number;
	/** Whether the figure actually falls inside the drawn range. A trip cheaper than the
	 * tenth percentile is drawn at the end of the track, and the copy says so rather than
	 * letting the marker imply it sits at exactly p10. */
	placement: 'below' | 'inside' | 'above';
	/** Which third of the drawn track the marker lands in, 0 cheapest. */
	zone: number;
}

/** Where one figure sits in a band. */
export function placeInBand(band: PriceHistory, minorUnits: number): BandPosition {
	const span = band.highMinorUnits - band.lowMinorUnits;
	// Every priced departure at the same price is a real answer for a route with one fare
	// all month. Mid-track is the only non-arbitrary place to draw it, and `placement`
	// still says whether this trip beats that price.
	const raw = span <= 0 ? 0.5 : (minorUnits - band.lowMinorUnits) / span;
	const fraction = Math.min(1, Math.max(0, raw));

	return {
		fraction,
		cheaperThan: band.departures.filter((departure) => departure.minorUnits > minorUnits).length,
		outOf: band.departures.length,
		placement: minorUnits < band.lowMinorUnits ? 'below' : minorUnits > band.highMinorUnits ? 'above' : 'inside',
		zone: Math.min(BAND_ZONES - 1, Math.floor(fraction * BAND_ZONES))
	};
}

/**
 * The figure this card can be compared with: one adult, both flights, nothing else.
 *
 * `undefined` for anything that cannot be compared honestly. A `'party-total'` fare has no
 * one-adult figure and dividing it by the traveller count would be an average rather than a
 * fare, the same rule `flexible-dates/record-results.ts` applies at the other end of this
 * pipeline. Two legs quoted in different currencies cannot be added at all, and this app
 * does no conversion.
 */
export function oneAdultFlightsTotal(itinerary: Itinerary): Money | undefined {
	const legs = [itinerary.outboundFlight, itinerary.onwardFlight];
	if (legs.some((leg) => leg.priceScope !== 'per-person')) return undefined;
	if (legs[0].price.currency !== legs[1].price.currency) return undefined;
	return {
		minorUnits: legs[0].price.minorUnits + legs[1].price.minorUnits,
		currency: legs[0].price.currency
	};
}

/**
 * The claim, in one sentence: how this trip ranks, over how many days, on which route.
 *
 * A rank, not an adjective. "Good price" and "typical" are verdicts we have no standing to
 * reach from one browser's history; "cheaper than 38 of the 47 days this browser could
 * price" is a count anybody can check against the same numbers. Both ends are named
 * explicitly rather than left to "all of them", because a reader who beats every observed
 * day should be told the size of the set they beat.
 */
export function bandRankSentence(
	position: BandPosition,
	route: { origin: IataAirportCode; destination: IataAirportCode }
): string {
	const where = `${route.origin} to ${route.destination}`;
	const days = `${position.outOf} ${position.outOf === 1 ? 'day' : 'days'}`;
	if (position.cheaperThan === position.outOf) {
		return `Cheaper than all ${days} this browser could price ${where}.`;
	}
	if (position.cheaperThan === 0) {
		return `Dearer than all ${days} this browser could price ${where}.`;
	}
	return `Cheaper than ${position.cheaperThan} of the ${days} this browser could price ${where}.`;
}

/**
 * The caveat, which is the half that keeps this honest.
 *
 * Two clauses, each said exactly once on the card. The month range, because a January fare
 * and a July fare are not evidence about each other and a reader is entitled to know which
 * departures went into the band. Then the whole difference between this and Google: they
 * are banding a market, we are banding one browser's own history, and the issue is explicit
 * that the copy has to say which claim it is making.
 *
 * What is on the track (one adult, flights only) is named beside the figure itself in
 * `PriceBand.svelte`, not repeated here.
 */
export function bandEvidenceSentence(band: PriceHistory): string {
	const fromMonth = monthStartOf(band.earliestDeparture);
	const toMonth = monthStartOf(band.latestDeparture);
	// The year is on the label because a band is evidence about a season as much as a route,
	// and "Mar" alone leaves a reader guessing which March. It is printed once when both ends
	// share a year, and twice when they do not.
	const from = fromMonth.slice(0, 4) === toMonth.slice(0, 4) ? shortMonthLabel(fromMonth) : monthLabel(fromMonth);
	const span =
		fromMonth === toMonth ? `Departures in ${monthLabel(toMonth)}` : `Departures from ${from} to ${monthLabel(toMonth)}`;
	return `${span}. Prices seen in this browser, not the market.`;
}
