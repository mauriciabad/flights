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

import type { FareConversion, IsoCurrencyCode, Itinerary, Money, Stay, Transfer } from '$lib/domain';
import { groundFare, unpricedTransferLegs, walkedTransferLegs } from '$lib/domain';
import { scaleFareForParty, sumMoney } from '$lib/algorithm/build';
import { formatDuration, formatLongDuration, formatMoney, formatMoneyRange } from '$lib/format';
import { bedNightlyRate } from '$lib/stays/pricing';
import { fareAudience } from './itinerary-timeline-format';
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

/**
 * Everything the builder can produce, in the order a totals bar reads them: the parts
 * first, then what they add up to.
 *
 * Issue #309 left this without a renderer in the app. The timeline's totals rail was the
 * only caller, and it printed four of these six a few centimetres under the identical rail
 * on the card, so it went; the two it did not duplicate, `nights` and `total-price`, are on
 * the card as the trip strip's caption and as the headline with its receipt. What still
 * reads it is `ItineraryTimelineSelectionHarness`, which stands in for the card while a
 * unit test checks that a waiting-time edit reaches the caller's itinerary. If nothing has
 * claimed `nights` or `total-price` by the time somebody next reads this, they and
 * `totalPriceCaveat` are dead and should go.
 */
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
 *
 * Since issue #309 these four are the only ones on screen anywhere, and this rail is the
 * only thing that prints them. The owner's rule is that expanding a card must not change
 * what it says, so a second copy of any of them is a defect wherever it appears.
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
 *
 * Issue #249 puts a size on the second omission where the app has one. "Excludes ground
 * transport, about £24.26-£38.30" is the same admission with the hole measured, and the
 * measurement is the whole reason this line changed: a traveller comparing a €238 trip
 * against a €265 one cannot judge whether the gap matters until somebody says roughly how
 * big it is. The figure only appears when every excluded ride has an estimate in one
 * currency; a trip mixing a rated ride with an unrated one falls back to the bare sentence
 * rather than naming a number that covers some of the gap and reads as if it covered all
 * of it.
 */
function totalPriceCaveat(itinerary: Itinerary): string | undefined {
	const missingStay = !itinerary.stay && itinerary.nightsInConnection > 0;
	const ground = groundFares(itinerary);
	const missingGround = ground.unpricedRides > 0 || ground.estimates.length > 0;
	if (missingStay && missingGround) return 'excludes a bed and ground transport';
	if (missingStay) return 'excludes an unpriced stay';
	if (!missingGround) return undefined;
	const [only] = ground.estimates;
	if (only && ground.estimates.length === 1 && ground.unpricedRides === 0) {
		return `excludes ground transport, about ${formatMoneyRange(only.lowMinorUnits, only.highMinorUnits, only.currency)}`;
	}
	return 'excludes unpriced ground transport';
}

/**
 * One currency's worth of rate-card estimate for this trip: the rides it covers and what
 * they add up to at each end of the range. Issue #249.
 *
 * Per currency, not per trip, and that is not a hypothetical. A trip with an origin
 * location in Spain and a stopover in Britain has one leg rated in EUR and another in GBP,
 * `sumMoney` throws on the mix by design, and there is no converter in this codebase
 * (issue #152 is the bug that made that rule). So the receipt prints one line per currency
 * instead of one wrong line.
 *
 * `lowMinorUnits`/`highMinorUnits` rather than two `Money` values, matching `FareRange`
 * itself: a `Money` is a figure a screen prints as confirmed, and neither of these bounds
 * is one.
 */
export interface EstimatedGroundFare {
	rides: number;
	currency: IsoCurrencyCode;
	lowMinorUnits: number;
	highMinorUnits: number;
}

/** Every ground leg of this trip, sorted into what the app knows about its cost. Issue
 * #249, and the one place the receipt and the total's caveat both read from, so the chip
 * count and the sentence under the number can never disagree. */
interface GroundFareSummary {
	/** Legs walked, and therefore free. */
	walks: number;
	/** Rate-card ranges, summed per currency. Empty for a trip nobody could rate. */
	estimates: EstimatedGroundFare[];
	/** Rides whose cost this app has no number for at all: a bus nobody quotes, a ride past
	 * what any rate card describes (issue #246), or a leg no provider could route (issue
	 * #211). */
	unpricedRides: number;
}

/**
 * Sorts this trip's ground legs by what the app knows about each one. Issue #204's count,
 * split by issue #249 into the part that has a number and the part that does not.
 *
 * Three things put a ride in `unpricedRides`, and they are the same fact to a traveller
 * reading a price. A leg the provider routed and quoted nothing for. A leg it declined to
 * rate because the ride is longer than any card describes. And a connection-side leg that
 * does not exist at all, on a stopover that has a bed to reach, which is issue #211's
 * state: the bed is priced and no provider could route to it. Either way the traveller
 * still has to get from the runway to the bed and back, and the total says nothing about
 * what that costs.
 *
 * A walk is never in that count. Walking is free and this app knows it.
 */
function groundFares(itinerary: Itinerary): GroundFareSummary {
	const byCurrency = new Map<IsoCurrencyCode, EstimatedGroundFare>();
	let unpricedRides = 0;
	for (const { transfer } of unpricedTransferLegs(itinerary)) {
		const fare = groundFare(transfer);
		if (fare.kind !== 'estimated') {
			unpricedRides++;
			continue;
		}
		const { currency, lowMinorUnits, highMinorUnits } = fare.estimate;
		const running = byCurrency.get(currency);
		if (running) {
			running.rides++;
			running.lowMinorUnits += lowMinorUnits;
			running.highMinorUnits += highMinorUnits;
		} else {
			byCurrency.set(currency, { rides: 1, currency, lowMinorUnits, highMinorUnits });
		}
	}
	// Issue #140's gate, for the same reason it gates the missing bed: a same-day
	// connection has no bed to reach, so a leg it does not have is not a leg that failed.
	// Only the two connection-side legs, since the outer two are absent whenever the query
	// carried no origin or destination location, which is a trip that genuinely has no such
	// ride rather than one nobody could route.
	if (itinerary.stay && itinerary.nightsInConnection > 0) {
		unpricedRides +=
			(itinerary.transferToHotel ? 0 : 1) + (itinerary.transferToConnectionAirport ? 0 : 1);
	}
	return { walks: walkedTransferLegs(itinerary).length, estimates: [...byCurrency.values()], unpricedRides };
}

/** One line of the brief's "price of each part": a named share of the total. */
export interface PricePart {
	id: 'flights' | 'stay' | 'ground';
	label: string;
	money: Money;
	/** Extra context the number alone does not carry, e.g. how many nights it covers. */
	detail?: string;
}

/**
 * What this app knows about one ground row's cost. Issue #305's receipt reads one row per
 * named leg rather than three aggregate rows, so the cost has to travel with the row
 * instead of being counted into a separate bucket.
 *
 * The four cases are `groundFare`'s own four answers narrowed to what a receipt can print.
 * `beyond-rate-card` and `unquoted` both land on `unknown`, because to a traveller reading
 * a price they are the same sentence: nobody has given us a number for this ride.
 */
export type GroundRowCost =
	| { kind: 'quoted'; money: Money }
	| { kind: 'free' }
	| {
			kind: 'estimated';
			currency: IsoCurrencyCode;
			lowMinorUnits: number;
			highMinorUnits: number;
			/** What this range was before it was put into the traveller's currency, when it
			 * was put into it at all. Issue #339: the receipt prints the converted figure,
			 * because that is the one a traveller can hold against the total above it, and
			 * names the original underneath, because that is the one the driver charges. */
			converted?: FareConversion;
			/** Who the range covers, when the ride was rated for a party. Issue #344, and see
			 * `fareAudience`: absent for a lone traveller and for a rate card whose basis is
			 * unchecked, which is why this is a string the picker also prints rather than a
			 * count this row would have to word for itself. */
			audience?: string;
	  }
	| { kind: 'unknown' };

/**
 * One named ground leg on the receipt, with what it costs.
 *
 * The owner named these rows himself: "the other sould be `Rides from and to hotel`
 * `Ride to destination` `Ride from origin`". The rows they replace were counts under one
 * word ("Ground, 3 rides"), which told a reader how big the hole was and never which part
 * of the journey it was in. A traveller who is walking to their hotel and taxiing to the
 * airport was reading one line that averaged the two.
 */
export interface GroundRow {
	id: 'from-origin' | 'hotel' | 'to-hotel' | 'from-hotel' | 'to-destination';
	label: string;
	cost: GroundRowCost;
}

/**
 * The bed, as its own group rather than one long line. Issue #305.
 *
 * The line it replaces was `Bed, 1 night × €52.85, 37.6 km from centre`, which wrapped to
 * two lines on a 375px card and put three different kinds of fact in one string. The owner
 * asked for a group titled Hotel with the rate on the right and the nights inside it.
 *
 * The nights split into the ones the flights force and the ones the traveller chose,
 * because since #230 every stopover opens at its shortest length and the ladder extends
 * it. "1 required night, 1 extra night" is the only place on the card that says which half
 * of the bed bill is a choice.
 *
 * The distance from the city centre is deliberately gone rather than moved: `PickedBed` in
 * the unfolded timeline prints the distance from the airport, and the stay picker prints
 * the distance from the centre beside every property. It was on this line because there
 * was nowhere else in #224; there is now.
 */
export interface HotelGroup {
	/** "€52.85/night", or "€52.85/night each" when the rate is per person (issue #206). */
	rate: string;
	rows: HotelNightsRow[];
}

export interface HotelNightsRow {
	id: 'required' | 'extra';
	/** "1 required night", "2 extra nights". */
	label: string;
	money: Money;
}

export interface PriceBreakdown {
	parts: PricePart[];
	total: Money;
	/** True when a night is spent here and no provider priced a bed for it, so `total` is
	 * a real number that is nonetheless not the whole trip. Never true for a same-day
	 * connection, which has no bed to be missing. */
	missingStay: boolean;
	/**
	 * Issue #204: how many rides this trip needs whose cost `total` does not include AND has
	 * no number for at all. Nobody quoted a fare, no rate card reaches that far (issue
	 * #246), or nobody could route the leg (issue #211). See `groundFares`.
	 *
	 * A count, not a boolean, because "the airport run, both ways" and "one leg of four"
	 * are different sizes of hole and the card says which. Never a Money: this is precisely
	 * the number the app does not have.
	 *
	 * Issue #249 narrowed it. It used to cover every unquoted ride including the ones the
	 * rate card can describe, which is why a trip with a €13 hop into town showed the same
	 * blank chip as one nothing could price. Those rides moved to `estimatedGround` below,
	 * so the two counts never describe the same leg twice.
	 */
	unpricedTransferCount: number;
	/**
	 * Issue #249: what the rate card says this trip's unquoted rides cost, summed per
	 * currency. Empty when nothing could be rated, which is every trip before this change
	 * and still every trip whose only ground is a bus.
	 *
	 * Deliberately NOT in `parts` and deliberately not added into `total`. `parts` is money
	 * somebody really quoted and it goes through `sumMoney`, which throws on a currency
	 * mix; this is a guess from a table of municipal tariffs, denominated in the ride's own
	 * country's currency rather than the search's. A guess inside the total would be a
	 * number a traveller can sort on, filter by and screenshot. `results/sort.ts` orders
	 * cheapest-first on `totalPrice.minorUnits` and `results/filters.ts` hides anything over
	 * the traveller's max price, so a filter that drops a trip on the strength of a card
	 * back-calculated from a 5 km London ride is worse than a gap, because it is invisible.
	 */
	estimatedGround: EstimatedGroundFare[];
	/**
	 * Issue #249: how many ground legs this trip walks, and therefore how much of it costs
	 * a known nothing. Alongside `unpricedTransferCount` and `estimatedGround`, every ground
	 * leg the trip has is on the receipt under the thing this app knows about its cost.
	 *
	 * A count rather than a `PricePart` carrying zero money, deliberately. `parts` is
	 * money somebody really quoted, it goes through `formatMoney` and it feeds `sumMoney`,
	 * so a zero part would print "€0.00" in the amounts column and read as a measured
	 * quote. That is the fabricated zero issue #212 removed, coming back in a new shape.
	 * The fact here is not an amount, it is that there is no amount to pay.
	 */
	walkedTransferCount: number;
	/**
	 * Issue #305: the bed as its own titled group, or absent on a trip that books none.
	 * `parts` no longer carries a `stay` entry; this replaced it, because a group with the
	 * rate on its header and a row per kind of night is three facts a receipt can align
	 * down one right edge, and one line of prose was not.
	 */
	hotel?: HotelGroup;
	/**
	 * Issue #305: one row per named ground leg, in trip order, each carrying what this app
	 * knows about that leg's cost. The aggregate counts above still exist because
	 * `totalPriceCaveat` reasons about how much of the trip is unpriced rather than about
	 * which leg is; these rows are what the receipt prints.
	 */
	groundRows: GroundRow[];
}

/** "€13.00/night", "€13.00/night each", "€44.00/night for 3": issue #206's nightly rate
 * with the audience `bedNightlyRate` decided, in the "symbol first, /night" shape
 * AGENTS.md fixes for every rate this app prints. `StopoverBlock` composes the same two
 * pieces, so the card and the panel can never disagree about the figure. */
function bedRate(stay: Stay, travellers: number): string {
	const rate = bedNightlyRate(stay, travellers);
	const perNight = `${formatMoney(rate.money)}/night`;
	return rate.audience ? `${perNight} ${rate.audience}` : perNight;
}

function nightsPhrase(count: number, kind: 'required' | 'extra'): string {
	return `${count} ${kind} ${count === 1 ? 'night' : 'nights'}`;
}

/**
 * The bed group. Issue #305.
 *
 * `requiredNights` is `ScoredResult.stopover.minimum`, the shortest stay this connection's
 * own flight pairings allow. Everything past it is a night the traveller added from the
 * ladder, and everything up to it is a night the schedule charges them for whether they
 * want it or not. A caller that does not know the minimum passes nothing, and every night
 * reads as required, which is the honest reading of "we do not know that any of these were
 * chosen".
 */
function buildHotelGroup(stay: Stay, nights: number, travellers: number, requiredNights?: number): HotelGroup {
	const required = Math.max(0, Math.min(nights, requiredNights ?? nights));
	const extra = nights - required;
	const money = (count: number): Money => ({
		minorUnits: stay.pricePerNight.minorUnits * count,
		currency: stay.pricePerNight.currency
	});
	const rows: HotelNightsRow[] = [];
	if (required > 0) rows.push({ id: 'required', label: nightsPhrase(required, 'required'), money: money(required) });
	if (extra > 0) rows.push({ id: 'extra', label: nightsPhrase(extra, 'extra'), money: money(extra) });
	return { rate: bedRate(stay, travellers), rows };
}

function costOf(transfer: Transfer): GroundRowCost {
	const fare = groundFare(transfer);
	switch (fare.kind) {
		case 'quoted':
			return { kind: 'quoted', money: fare.price };
		case 'free':
			return { kind: 'free' };
		case 'estimated':
			return {
				kind: 'estimated',
				currency: fare.estimate.currency,
				lowMinorUnits: fare.estimate.lowMinorUnits,
				highMinorUnits: fare.estimate.highMinorUnits,
				converted: fare.estimate.converted,
				audience: fareAudience(fare.estimate.party)
			};
		case 'beyond-rate-card':
		case 'unquoted':
			return { kind: 'unknown' };
	}
}

/**
 * The two hotel-side rides as one cost, or `undefined` when they cannot honestly be added.
 *
 * They merge only when both legs are the same kind of answer in the same currency. A walk
 * out and a taxi back are two different facts, and one row saying either "free" or "about
 * £12-£19" about the pair would be false in one direction. Those fall back to a row each,
 * which is why `GroundRow.id` has a `to-hotel` and a `from-hotel` as well as the merged
 * `hotel`.
 */
function mergeHotelCosts(a: GroundRowCost, b: GroundRowCost): GroundRowCost | undefined {
	if (a.kind !== b.kind) return undefined;
	if (a.kind === 'free' || a.kind === 'unknown') return a;
	if (a.kind === 'quoted' && b.kind === 'quoted') {
		if (a.money.currency !== b.money.currency) return undefined;
		return { kind: 'quoted', money: { minorUnits: a.money.minorUnits + b.money.minorUnits, currency: a.money.currency } };
	}
	if (a.kind === 'estimated' && b.kind === 'estimated') {
		if (a.currency !== b.currency) return undefined;
		// Issue #339: and not if they were converted out of different currencies either. The
		// two hotel-side legs are the same ride in reverse, so in practice they share a rate
		// card; a pair that did not could not honestly print one "from GBP" line, and a
		// merged row that dropped the source would be the converted figure standing alone
		// with nothing saying what it came from.
		if (a.converted?.from !== b.converted?.from) return undefined;
		// Issue #344, and the same rule one field along: two legs rated for different parties
		// cannot share a row that names one of them. In practice they never are, since both
		// hotel-side legs are rated from the same `SearchQuery.travellers`.
		if (a.audience !== b.audience) return undefined;
		return {
			kind: 'estimated',
			currency: a.currency,
			lowMinorUnits: a.lowMinorUnits + b.lowMinorUnits,
			highMinorUnits: a.highMinorUnits + b.highMinorUnits,
			audience: a.audience,
			converted:
				a.converted && b.converted
					? {
							from: a.converted.from,
							fromLowMinorUnits: a.converted.fromLowMinorUnits + b.converted.fromLowMinorUnits,
							fromHighMinorUnits: a.converted.fromHighMinorUnits + b.converted.fromHighMinorUnits,
							rateDate: a.converted.rateDate
						}
					: undefined
		};
	}
	return undefined;
}

/**
 * The receipt's ground rows, in trip order, named the way the owner named them.
 *
 * A leg the trip does not have gets no row, with one exception that is issue #211's:
 * a stopover with a booked bed and a night to sleep in it still has to reach that bed and
 * come back, so an absent connection-side leg is a ride nobody could route rather than a
 * ride the trip does not need. That is the same gate `groundFares` applies to the unpriced
 * count, and the two are kept in step deliberately: the row saying "not priced" and the
 * caveat under the total counting it have to describe the same legs.
 */
function buildGroundRows(itinerary: Itinerary): GroundRow[] {
	const rows: GroundRow[] = [];

	if (itinerary.transferToOriginAirport) {
		rows.push({ id: 'from-origin', label: 'Ride from origin', cost: costOf(itinerary.transferToOriginAirport) });
	}

	// Issue #211's gate, shared with `groundFares`: a bed to reach is what makes a missing
	// leg a hole rather than a leg the trip never had.
	const bedToReach = itinerary.stay !== undefined && itinerary.nightsInConnection > 0;
	const toHotel = itinerary.transferToHotel;
	const fromHotel = itinerary.transferToConnectionAirport;
	if (toHotel || fromHotel || bedToReach) {
		const toCost: GroundRowCost = toHotel ? costOf(toHotel) : { kind: 'unknown' };
		const fromCost: GroundRowCost = fromHotel ? costOf(fromHotel) : { kind: 'unknown' };
		const merged = mergeHotelCosts(toCost, fromCost);
		if (merged) rows.push({ id: 'hotel', label: 'Rides from and to hotel', cost: merged });
		else {
			rows.push({ id: 'to-hotel', label: 'Ride to hotel', cost: toCost });
			rows.push({ id: 'from-hotel', label: 'Ride from hotel', cost: fromCost });
		}
	}

	if (itinerary.transferToDestinationLocation) {
		rows.push({
			id: 'to-destination',
			label: 'Ride to destination',
			cost: costOf(itinerary.transferToDestinationLocation)
		});
	}

	return rows;
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

/** What the hotel group can say beyond its own amounts, when the caller knows it. */
export interface PriceBreakdownContext {
	/**
	 * `ScoredResult.stopover.minimum`: the fewest nights this connection's own flight
	 * pairings allow. Issue #305 splits the bed rows into the nights the schedule forces
	 * and the nights the traveller added on top, and this is the line between them.
	 *
	 * Absent, every night reads as required. That is the honest default: without the
	 * group behind the card there is no way to know that any night was chosen, and calling
	 * a forced night "extra" would tell a traveller they could drop it.
	 */
	requiredNights?: number;
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
 * Issue #249 closes the other two silences. Naming only the unquoted rides left the walked
 * legs off the receipt entirely: measured on production on 2026-09-05, three taxis and one
 * walk printed as "Ground, 3 rides not priced" with the fourth leg nowhere, and a trip
 * walked at both ends printed no ground line at all, which reads exactly like a trip with
 * no ground legs. `walkedTransferCount` is that half. `estimatedGround` is the other: the
 * app has held a rate-card range for a short taxi since issue #9 and showed it only inside
 * the transport picker, so the receipt said "not priced" about a ride the same screen
 * priced one tap deeper. Between the three, every ground leg the trip has is on the
 * receipt, each under the thing this app actually knows about its cost.
 */
export function priceBreakdown(itinerary: Itinerary, context: PriceBreakdownContext = {}): PriceBreakdown {
	const flights = sumMoney(
		scaleFareForParty(itinerary.outboundFlight, itinerary.travellers),
		scaleFareForParty(itinerary.onwardFlight, itinerary.travellers)
	);
	const parts: PricePart[] = [{ id: 'flights', label: 'Flights', money: flights }];

	const hotel =
		itinerary.stay && itinerary.nightsInConnection > 0
			? buildHotelGroup(itinerary.stay, itinerary.nightsInConnection, itinerary.travellers, context.requiredNights)
			: undefined;

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

	const ground = groundFares(itinerary);
	return {
		parts,
		total: itinerary.totalPrice,
		missingStay: !itinerary.stay && itinerary.nightsInConnection > 0,
		unpricedTransferCount: ground.unpricedRides,
		estimatedGround: ground.estimates,
		walkedTransferCount: ground.walks,
		hotel,
		groundRows: buildGroundRows(itinerary)
	};
}
