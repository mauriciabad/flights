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

import type { Coordinates, Itinerary, Money, Stay } from '$lib/domain';
import { greatCircleDistanceKm, unpricedTransferLegs, walkedTransferLegs } from '$lib/domain';
import { scaleFareForParty, sumMoney } from '$lib/algorithm/build';
import { formatDuration, formatLongDuration, formatMoney } from '$lib/format';
import { formatDistanceKm } from '$lib/stays/distance';
import { bedNightlyRate } from '$lib/stays/pricing';
import { freeTimeDays } from './free-time-days';

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
 * Free time is what the stopover is actually worth, and since issue #228 it is a count of
 * whole days rather than a duration. The card gets the count alone: the two edge times and
 * the stay they bracket are the expanded panel's `StopoverBlock`, because seven lines
 * repeated down a results list is not a results screen.
 *
 * In-flight and airport waiting are the two halves of "how much of this trip is spent
 * travelling", and they are the pair the traveller trades against price. Door to door
 * closes it.
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
				// Issue #228. This cell used to be `formatLongDuration(times.free)`, and the
				// owner's objection to that is the issue: "showing the duration as '2d 15h
				// free' on the free days is misleading and wrong". A duration answers "how
				// long"; what a person asks about a stopover is how many whole days they
				// get. `StopoverBlock` in the expanded panel is the long form of this cell:
				// the same count, with its two edge times and the stay they bracket.
				value: freeTimeDays(itinerary.freeTime.start, itinerary.freeTime.end)?.count ?? 'No full days',
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
				note: totalPriceCaveat(itinerary)
			};
	}
}

/**
 * What this total leaves out, or nothing when it leaves out nothing.
 *
 * Issue #140: only a stopover that actually spends a night is missing a bed. On a same-day
 * connection the total is complete on that count, and warning that it excludes a stay
 * would invent a cost the trip never had.
 *
 * Issue #204 adds the second omission, which had been silent since the app shipped: no
 * transfer provider quotes a fare, so every ground leg that is not walked contributes
 * nothing to this figure. One sentence covers both, because two caveats stacked under one
 * number read as two separate problems when they are one. The total is a floor.
 */
function totalPriceCaveat(itinerary: Itinerary): string | undefined {
	const missingStay = !itinerary.stay && itinerary.nightsInConnection > 0;
	const missingGround = groundCostUnknownFor(itinerary) > 0;
	if (missingStay && missingGround) return 'excludes a bed and ground transport';
	if (missingStay) return 'excludes an unpriced stay';
	if (missingGround) return 'excludes unpriced ground transport';
	return undefined;
}

/**
 * How many rides this trip needs whose cost is not in `totalPrice` — issue #204.
 *
 * Two things put a ride in this count, and they are the same fact to a traveller reading a
 * price. A leg that exists but carries no fare is `unpricedTransferLegs`: the provider
 * routed it and quoted nothing. A connection-side leg that does not exist at all, on a
 * stopover that has a bed to reach, is issue #211's state: the bed is priced and no
 * provider could route to it. Either way the traveller still has to get from the runway to
 * the bed and back, and the total says nothing about what that costs.
 *
 * A walk is never counted, here or in `unpricedTransferLegs`. Walking is free.
 */
function groundCostUnknownFor(itinerary: Itinerary): number {
	const unpriced = unpricedTransferLegs(itinerary).length;
	// Issue #140's gate, for the same reason it gates the missing bed: a same-day
	// connection has no bed to reach, so a leg it does not have is not a leg that failed.
	if (!itinerary.stay || itinerary.nightsInConnection === 0) return unpriced;
	// Only the two connection-side legs. The outer two are absent whenever the query
	// carried no origin or destination location, which is a trip that genuinely has no such
	// ride rather than one nobody could route.
	const unrouted =
		(itinerary.transferToHotel ? 0 : 1) + (itinerary.transferToConnectionAirport ? 0 : 1);
	return unpriced + unrouted;
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
	/**
	 * Issue #204: how many rides this trip needs whose cost `total` does not include, either
	 * because nobody quoted a fare for them or because nobody could route them at all
	 * (issue #211). See `groundCostUnknownFor`. Zero for a trip whose every leg is walked
	 * or priced, which is the only case where `total` is the whole answer.
	 *
	 * A count, not a boolean, because "the airport run, both ways" and "one leg of four"
	 * are different sizes of hole and the card says which. It is never a Money: this is
	 * precisely the number the app does not have, and the one distance-derived range it
	 * does have (`FareEstimate`) is in the rate card's own currency, so it belongs
	 * beside its leg in `TransportPicker`, not added into a figure in another currency.
	 */
	unpricedTransferCount: number;
	/**
	 * Issue #249: how many ground legs this trip walks, and therefore how much of it costs
	 * a known nothing. The other half of `unpricedTransferCount`, and together they cover
	 * every ground leg the trip has.
	 *
	 * A count rather than a `PricePart` carrying zero money, deliberately. `parts` is
	 * money somebody really quoted, it goes through `formatMoney` and it feeds `sumMoney`,
	 * so a zero part would print "€0.00" in the amounts column and read as a measured
	 * quote. That is the fabricated zero issue #212 removed, coming back in a new shape.
	 * The fact here is not an amount, it is that there is no amount to pay.
	 */
	walkedTransferCount: number;
}

/**
 * How far the booked bed is from the middle of the stopover city, straight-line, or
 * `undefined` when either point is unknown. Never the walking or driving distance: those
 * are a routing provider's answer and this is arithmetic on two coordinates, which is
 * exactly why `formatDistanceKm` keeps it to one decimal.
 */
function distanceFromCentre(itinerary: Itinerary, cityCentre: Coordinates | undefined): string | undefined {
	if (!itinerary.stay || !cityCentre) return undefined;
	return `${formatDistanceKm(greatCircleDistanceKm(itinerary.stay.property.coordinates, cityCentre))} from centre`;
}

/** "€13.00", "€13.00 each", "€44.00 for 3": issue #206's nightly rate with the audience
 * `bedNightlyRate` decided. `StopoverBlock` composes the same two pieces into its own
 * "€13.00/night each", so the card and the panel can never disagree about the figure. */
function bedRate(stay: Stay, travellers: number): string {
	const rate = bedNightlyRate(stay, travellers);
	return rate.audience ? `${formatMoney(rate.money)} ${rate.audience}` : formatMoney(rate.money);
}

/** "3 rides" rather than a bare 3, because a number beside the word "Ground" reads as an
 * amount of money, which is the one thing it is not. */
export function rideCount(rides: number): string {
	return `${rides} ${rides === 1 ? 'ride' : 'rides'}`;
}

/** "1 walk", for the same reason, and "walk" rather than "leg on foot" because that is the
 * mode's own noun on every other screen: `StopoverBlock` prints "Walk, 15m from the
 * airport" and `transferModeLabel` calls it "Walk". */
export function walkCount(walks: number): string {
	return `${walks} ${walks === 1 ? 'walk' : 'walks'}`;
}

/** What the bed line can say beyond its own amount, when the caller knows it. */
export interface PriceBreakdownContext {
	/**
	 * The stopover city's hand-checked centre point (`Airport.city.coordinates`, issue
	 * #162), when one exists. Present, the bed line says how far out the bed is; absent,
	 * it says nothing rather than measuring against the runway and calling that the
	 * centre, which is the mistake #196 fixed.
	 *
	 * Issue #224: the owner's two stated reasons for extending a stopover are "if the city
	 * is interesting and the hotel in the center", and this is the measurable one. It rides
	 * on the line that already prints what the bed costs, so the card answers "is it worth
	 * another night here" without spending a row on it.
	 */
	cityCentre?: Coordinates;
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
 *
 * Issue #204: `ground` being absent used to be the end of the story, which is how a trip
 * needing two taxis came to show the same receipt as one you walk. `unpricedTransferCount`
 * named the rides nobody quoted, which told those two apart.
 *
 * Issue #249 closes the other silence. Naming only the unquoted rides left the walked legs
 * off the receipt entirely: measured on production on 2026-09-05, three taxis and one walk
 * printed as "Ground, 3 rides not priced" with the fourth leg nowhere, and a trip walked at
 * both ends printed no ground line at all, which reads exactly like a trip with no ground
 * legs. `walkedTransferCount` is that half. Between the two counts every ground leg the
 * trip has is on the receipt, each under the thing this app actually knows about its cost.
 */
export function priceBreakdown(itinerary: Itinerary, context: PriceBreakdownContext = {}): PriceBreakdown {
	const flights = sumMoney(
		scaleFareForParty(itinerary.outboundFlight, itinerary.travellers),
		scaleFareForParty(itinerary.onwardFlight, itinerary.travellers)
	);
	const parts: PricePart[] = [{ id: 'flights', label: 'Flights', money: flights }];

	if (itinerary.stay && itinerary.nightsInConnection > 0) {
		const nights = itinerary.nightsInConnection;
		// The nightly rate beside the night count, so the line explains its own total and
		// answers issue #225's "+x€per night" for accommodation on the card itself rather
		// than only inside the stay picker.
		const detail = [
			`${nights} ${nights === 1 ? 'night' : 'nights'} × ${bedRate(itinerary.stay, itinerary.travellers)}`,
			distanceFromCentre(itinerary, context.cityCentre)
		].filter((part): part is string => part !== undefined);
		parts.push({
			id: 'stay',
			label: 'Bed',
			money: {
				minorUnits: itinerary.stay.pricePerNight.minorUnits * nights,
				currency: itinerary.stay.pricePerNight.currency
			},
			detail: detail.join(', ')
		});
	}

	const groundLegs = [
		itinerary.transferToOriginAirport?.price,
		itinerary.transferToHotel?.price,
		itinerary.transferToConnectionAirport?.price,
		itinerary.transferToDestinationLocation?.price
	].filter((price): price is Money => price !== undefined);
	if (groundLegs.length > 0) {
		parts.push({
			id: 'ground',
			label: 'Ground',
			money: sumMoney(groundLegs[0]!, ...groundLegs.slice(1)),
			// The size of what the money bought, matching the unpriced chip's own count so a
			// trip with two quoted rides and two unquoted ones reads as four legs rather than
			// as one line contradicting the other. A walked leg is in neither count: walking
			// is free and this app knows it (`domain/transfer.ts`).
			detail: rideCount(groundLegs.length)
		});
	}

	return {
		parts,
		total: itinerary.totalPrice,
		missingStay: !itinerary.stay && itinerary.nightsInConnection > 0,
		unpricedTransferCount: groundCostUnknownFor(itinerary),
		walkedTransferCount: walkedTransferLegs(itinerary).length
	};
}
