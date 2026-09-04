/**
 * The numbers about one itinerary, derived once.
 *
 * Before this module the same handful of figures was assembled in three places that had
 * drifted apart: `ResultCard` showed two of them, `ItineraryTimeline`'s totals bar showed
 * six under one set of labels ("Airport waiting", "Nights in connection"), and the
 * comparator's footer showed five under another ("Airport time", "Nights"). That third
 * copy also still printed "No stay priced" in the nights slot, the exact mistake issues
 * #105/#108/#140 removed everywhere else: a stopover's night count comes off the flight
 * schedule alone and is true whether or not any provider ever priced a bed for it. The
 * comparator itself is gone since #178, which removes that copy but not the reason the
 * other two disagreed.
 *
 * One builder, one vocabulary. Pure, so the labels and the arithmetic are testable
 * without mounting Svelte, which is where AGENTS.md wants logic to live.
 *
 * The set of figures is not a design choice made here. Brief lines 55 to 60 name exactly
 * these: in-flight time, airport waiting time, free time, nights in the connection, the
 * time and price of each part, and the totals.
 */

import type { Itinerary, Money } from '$lib/domain';
import { scaleFareForParty, sumMoney } from '$lib/algorithm/build';
import { formatDuration, formatLongDuration, formatMoney } from '$lib/format';

export type ItineraryMetricId =
	| 'in-flight'
	| 'airport-waiting'
	| 'free-time'
	| 'nights'
	| 'total-time'
	| 'total-price';

export interface ItineraryMetric {
	id: ItineraryMetricId;
	/** Short enough to sit above its own number in a 4rem column on a 375px screen. */
	label: string;
	value: string;
	/** `stopover` is the teal reserved for the free city (app.css), `primary` is a total.
	 * A component maps this to a class; it never re-derives which figure is which. */
	tone: 'default' | 'stopover' | 'primary';
	/** A caveat that is true at the same time as the number, never instead of it. */
	note?: string;
}

/** Everything the builder can produce, in the order a totals bar reads them: the parts
 * first, then what they add up to. */
export const ALL_METRIC_IDS: readonly ItineraryMetricId[] = [
	'in-flight',
	'airport-waiting',
	'free-time',
	'nights',
	'total-time',
	'total-price'
];

/**
 * The four figures a results card carries, and the argument for each one.
 *
 * Free time is what the stopover is actually worth. In-flight and airport waiting are
 * the two halves of "how much of this trip is spent travelling", and they are the pair
 * the traveller trades against price. Door to door closes it.
 *
 * Nights is deliberately absent: the trip strip above this rail already prints "2 nights
 * in Vienna" in bold teal, so a NIGHTS cell repeated the one figure the card shows as a
 * shape. Total price is absent for the same reason: it is the card's headline, printed
 * once at the top with its own breakdown. Four cells also fit a 375px card in two rows of
 * two, where five left a dangling cell and an empty slot.
 */
export const CARD_METRIC_IDS: readonly ItineraryMetricId[] = [
	'free-time',
	'in-flight',
	'airport-waiting',
	'total-time'
];

export function itineraryMetrics(
	itinerary: Itinerary,
	ids: readonly ItineraryMetricId[] = ALL_METRIC_IDS
): ItineraryMetric[] {
	return ids.map((id) => buildMetric(itinerary, id));
}

function buildMetric(itinerary: Itinerary, id: ItineraryMetricId): ItineraryMetric {
	switch (id) {
		case 'in-flight':
			return { id, label: 'In flight', value: formatDuration(itinerary.times.inFlight), tone: 'default' };
		case 'airport-waiting':
			return {
				id,
				label: 'Airport wait',
				value: formatDuration(itinerary.times.airportWaiting),
				tone: 'default'
			};
		case 'free-time':
			return {
				id,
				label: 'Free time',
				value: formatLongDuration(itinerary.times.free),
				tone: 'stopover'
			};
		case 'nights':
			return {
				id,
				label: 'Nights',
				// Issue #105: off the flight schedule alone, never off whether a bed was
				// priced. A 12-night stopover is 12 nights with no stay provider configured,
				// which is every first-time visitor's state.
				value: String(itinerary.nightsInConnection),
				// No "no bed priced" caveat here: the count is a fact about the schedule and
				// the missing bed is a fact about the price, so the caveat rides on
				// `total-price` below and on `PriceLine`. Printing it under both figures put
				// the same warning twice on one card, a few centimetres apart.
				tone: 'stopover'
			};
		case 'total-time':
			return {
				id,
				label: 'Door to door',
				value: formatLongDuration(itinerary.times.total),
				tone: 'primary'
			};
		case 'total-price':
			return {
				id,
				label: 'Total price',
				value: formatMoney(itinerary.totalPrice),
				tone: 'primary',
				// Issue #140: only a stopover that actually spends a night is missing
				// anything. On a same-day connection this total is complete, and warning
				// that it excludes a stay would invent a cost the trip never had.
				note:
					!itinerary.stay && itinerary.nightsInConnection > 0
						? 'excludes an unpriced stay'
						: undefined
			};
	}
}

/** One line of the brief's "price of each part": a named share of the total. */
export interface PricePart {
	id: 'flights' | 'stay' | 'ground';
	label: string;
	money: Money;
	/** Extra context the number alone does not carry, e.g. how many nights it covers. */
	detail?: string;
}

export interface PriceBreakdown {
	parts: PricePart[];
	total: Money;
	/** True when a night is spent here and no provider priced a bed for it, so `total` is
	 * a real number that is nonetheless not the whole trip. Never true for a same-day
	 * connection, which has no bed to be missing. */
	missingStay: boolean;
}

/**
 * Splits `totalPrice` back into the parts that made it.
 *
 * Reuses `buildItineraries`' own `scaleFareForParty` and `sumMoney` rather than
 * re-deriving the arithmetic, so this can never disagree with the total it is explaining.
 * That matters more than it sounds: a flight fare scales to the party by that offer's own
 * declared `priceScope` (issue #109), so "multiply the two fares by travellers" would be
 * wrong for a Skyscanner leg and right for a Ryanair one, and a hand-rolled breakdown
 * would print a subtotal that does not add up to the number above it.
 *
 * A part with no money in it is left out rather than printed as zero. No transfer
 * provider populates `Transfer.price` today (domain/transfer.ts), so `ground` is normally
 * absent, and it appears on its own the day one does.
 */
export function priceBreakdown(itinerary: Itinerary): PriceBreakdown {
	const flights = sumMoney(
		scaleFareForParty(itinerary.outboundFlight, itinerary.travellers),
		scaleFareForParty(itinerary.onwardFlight, itinerary.travellers)
	);
	const parts: PricePart[] = [{ id: 'flights', label: 'Flights', money: flights }];

	if (itinerary.stay && itinerary.nightsInConnection > 0) {
		const nights = itinerary.nightsInConnection;
		parts.push({
			id: 'stay',
			label: 'Bed',
			money: {
				minorUnits: itinerary.stay.pricePerNight.minorUnits * nights,
				currency: itinerary.stay.pricePerNight.currency
			},
			detail: `${nights} ${nights === 1 ? 'night' : 'nights'}`
		});
	}

	const groundLegs = [
		itinerary.transferToOriginAirport?.price,
		itinerary.transferToHotel?.price,
		itinerary.transferToConnectionAirport?.price,
		itinerary.transferToDestinationLocation?.price
	].filter((price): price is Money => price !== undefined);
	if (groundLegs.length > 0) {
		parts.push({ id: 'ground', label: 'Ground', money: sumMoney(groundLegs[0]!, ...groundLegs.slice(1)) });
	}

	return {
		parts,
		total: itinerary.totalPrice,
		missingStay: !itinerary.stay && itinerary.nightsInConnection > 0
	};
}
