/**
 * Issue #14: "Scoring: make the free trip count."
 *
 * The product thesis, in the owner's words (docs/prompts/001-initial-brief.md):
 * "when i eant to go to a location that doesnt have direct flights i want to spend some
 * days in a in-between city, this saves money and gives me a trip 'for free'."
 *
 * A plain cheapest-total sort defeats that: it ranks a 90-minute layover above three
 * nights in Vienna that cost eight euros more. Everything below scores an Itinerary on a
 * single scale — euro-equivalent "goodness", higher is better — so the free-time bonus and
 * the price can be weighed against each other instead of the price silently winning.
 *
 * Pure functions only. No I/O, no Svelte, nothing that reaches outside src/lib/domain.
 */

import type { IataAirlineCode } from '../domain/codes';
import type { LocalDateTime } from '../domain/datetime';
import { unpricedTransferLegs } from '../domain/itinerary';
import type { FreeTime, Itinerary } from '../domain/itinerary';
import { majorUnitsOf } from '../domain/money';

// ---------------------------------------------------------------------------
// Free-time usability
// ---------------------------------------------------------------------------

/**
 * How usable one hour of the day is for actually doing something in a stopover city,
 * rather than lying in a hotel bed. Piecewise-linear so the acceptance case in issue #14
 * ("Free time from 03:00 to 07:00 is not a trip, it is a bad night") falls out of the
 * curve itself instead of a special case: 03:00-07:00 sits almost entirely in the 0-weight
 * band, a same-length daytime window sits entirely in the 1-weight band.
 *
 * Breakpoints, all local clock hours:
 * - 0-6: no credit. A traveller is asleep (or should be); nothing city-side is open.
 * - 6-9: ramps 0 -> 1. Waking up, breakfast, the day starting.
 * - 9-21: full credit. The actual sightseeing-and-dinner day.
 * - 21-24: ramps 1 -> 0. Winding down toward the next night's 0-6 band.
 */
function usabilityWeightAtHour(hourOfDay: number): number {
	const h = ((hourOfDay % 24) + 24) % 24;
	if (h < 6) return 0;
	if (h < 9) return (h - 6) / 3;
	if (h < 21) return 1;
	return 1 - (h - 21) / 3;
}

/** Width of one sampling slice used to integrate usabilityWeightAtHour over a free-time
 * window. Fine enough that the 3-hour dawn/dusk ramps aren't rounded away, coarse enough
 * that even a two-week free time (the longest a stopover could plausibly run) integrates
 * in a few thousand steps — cheap for a function called once per itinerary per search. */
const USABILITY_SAMPLE_STEP_HOURS = 1 / 12; // 5 minutes

/**
 * Converts a LocalDateTime's wall-clock reading into a plain hour count, monotonic across
 * calendar days, usable for interval arithmetic.
 *
 * Date.UTC here is a calendar calculator, never a real instant: it is fed the digits typed
 * on the clock, not the actual UTC time they represent. That is deliberate. AGENTS.md's
 * timezone rule exists because collapsing a wall-clock reading to a real UTC instant loses
 * the "which calendar day is this" story a LocalDateTime carries — but usableFreeHours
 * only ever compares a FreeTime's start against its own end, both readings taken in the
 * same connection city, so plain wall-clock subtraction is exactly "how many hours of
 * local daylight did this stopover span", with no timezone conversion needed or wanted.
 */
function wallClockHours(dt: LocalDateTime): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(dt.local);
	if (!match) {
		throw new Error(`Unparseable LocalDateTime.local: "${dt.local}"`);
	}
	const [, year, month, day, hour, minute, second] = match;
	const ms = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second ?? '0')
	);
	return ms / (1000 * 60 * 60);
}

/**
 * Integrates usabilityWeightAtHour across a free-time window and returns the result in
 * "usable hours" — a 4-hour daytime window returns close to 4, a 4-hour 03:00-07:00
 * window returns close to 0. Multi-day stopovers are handled the same way: the curve
 * just repeats once per calendar day.
 *
 * FreeTime.start and FreeTime.end are assumed to share a timeZone (both are readings in
 * the same connection city) — see wallClockHours above for why that lets this stay plain
 * subtraction instead of real timezone-aware arithmetic.
 */
export function usableFreeHours(freeTime: FreeTime): number {
	const startHours = wallClockHours(freeTime.start);
	const endHours = wallClockHours(freeTime.end);
	if (endHours <= startHours) return 0;

	let usable = 0;
	for (let t = startHours; t < endHours; t += USABILITY_SAMPLE_STEP_HOURS) {
		const sliceEnd = Math.min(t + USABILITY_SAMPLE_STEP_HOURS, endHours);
		const sliceLength = sliceEnd - t;
		// Sampling the midpoint keeps the approximation centred on each slice instead of
		// biased toward its start, which matters right at the dawn/dusk ramps.
		usable += usabilityWeightAtHour(t + sliceLength / 2) * sliceLength;
	}
	return usable;
}

/**
 * Issue #167: the same "usable hours" integral as above, with every hour additionally
 * discounted by which day of the stopover it falls on — hours on the first day count in
 * full, hours on the second count `decay`, on the third `decay²`, and so on.
 *
 * Scoring uses this; `usableFreeHours` above stays undiscounted because the results card
 * reports it to the traveller as a plain fact ("about 6h free in the stopover"), and a
 * discounted hour is not an hour.
 *
 * Without this, decaying the night bonus alone would have fixed half the runaway. Free
 * time grows with the stopover just as nights do — roughly 15 usable hours per extra day,
 * worth about 22 points at `usableFreeTimeWeightPerHour` — so a 24-night stay would still
 * have collected an unbounded 22 points a night after the night bonus flattened out. The
 * justification is the same one `stopoverDecayPerNight` carries: the tenth afternoon in a
 * city is not worth what the first one was.
 *
 * `decay` outside (0, 1) is treated as no discount at all, so a caller who overwrites the
 * weight with 1 gets the old linear behaviour rather than a NaN.
 */
function discountedUsableFreeHours(freeTime: FreeTime, decay: number): number {
	const startHours = wallClockHours(freeTime.start);
	const endHours = wallClockHours(freeTime.end);
	if (endHours <= startHours) return 0;
	if (!(decay > 0 && decay < 1)) return usableFreeHours(freeTime);

	let usable = 0;
	for (let t = startHours; t < endHours; t += USABILITY_SAMPLE_STEP_HOURS) {
		const sliceEnd = Math.min(t + USABILITY_SAMPLE_STEP_HOURS, endHours);
		const sliceLength = sliceEnd - t;
		const dayIndex = Math.floor((t - startHours) / 24);
		usable += usabilityWeightAtHour(t + sliceLength / 2) * sliceLength * Math.pow(decay, dayIndex);
	}
	return usable;
}

/**
 * Total night bonus for a stopover of `nights` calendar nights: a geometric series, the
 * first night worth `firstNightBonus` and each further night `decay` times the one before.
 * Bounded above by `firstNightBonus / (1 - decay)` however long the stopover runs — see
 * `ScoringWeights.stopoverDecayPerNight` for why that bound is the whole point.
 *
 * Exported so a test can assert the curve's shape directly rather than inferring it from
 * whole-itinerary scores, and so anything that wants to explain a ranking can quote the
 * same number the scorer used.
 */
export function nightBonus(nights: number, firstNightBonus: number, decay: number): number {
	if (nights <= 0) return 0;
	// decay === 1 is the old unbounded linear behaviour; anything outside (0, 1] would make
	// the series meaningless, so it collapses to "the first night only".
	if (decay >= 1) return firstNightBonus * nights;
	if (decay <= 0) return firstNightBonus;
	return (firstNightBonus * (1 - Math.pow(decay, nights))) / (1 - decay);
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

/**
 * Every dial the scoring formula has, all expressed on one scale: euro-equivalent points,
 * where a weight of N literally means "worth N units of the search's currency to me".
 * That common scale is what makes it meaningful to trade a price difference off against a
 * night in Vienna instead of just picking arbitrary numbers per factor.
 *
 * Whatever DEFAULT_SCORING_WEIGHTS below picks is wrong for somebody — a family with a
 * toddler values a short travel time completely differently from a backpacker who came
 * for the stopover. That is why this is a plain object the UI can read and overwrite
 * field by field, not a formula with constants baked in.
 */
export interface ScoringWeights {
	/** Score lost per major unit of total price (e.g. per euro). Fixed at 1 so every other
	 * weight below is denominated in the same units — money is already the natural scale
	 * a traveller comparing flight prices thinks in, so nothing else needs converting to
	 * match it, only price. */
	pricePerCurrencyUnit: number;

	/** Score lost per hour of unavoidable travel overhead: both flights, both airport
	 * waits, and every transfer leg — everything in the itinerary except the free time in
	 * the connection city. Kept low (0.5) because for this app's traveller a long trip is
	 * often the point, not a defect, so total duration alone shouldn't dominate the way it
	 * does on a generic flight search. */
	travelTimeWeightPerHour: number;

	/** Extra score lost per hour spent specifically waiting inside an airport, layered on
	 * top of the general travel-time weight above. Set higher (2) than travel time overall
	 * because idle time behind security — no bed, nothing to do, a departures board to
	 * stare at — is more tedious per minute than the same hour on a plane or a train into
	 * town, even though both count toward the same total duration. */
	airportWaitingWeightPerHour: number;

	/** Score gained for the FIRST night spent in the connection city. This is the product
	 * thesis, so it is deliberately the single biggest number in this config: 40 means one
	 * night in Vienna outweighs a forty-euro price gap, and two nights (70, see
	 * `stopoverDecayPerNight`) comfortably outweigh the eight-euro gap the brief itself
	 * describes, while still losing to a price difference in the hundreds.
	 *
	 * Issue #167: this used to be a flat per-night rate, multiplied by the night count with
	 * no upper bound. Once #166 gave every stopover a month of dated fares to choose
	 * between, "more nights is always better" made the top result a 24-night stay in
	 * Bergamo. See `stopoverDecayPerNight`. */
	firstNightBonus: number;

	/**
	 * What each further night of the stopover is worth as a fraction of the night before
	 * it — 0.75 means the second night earns 30 points, the third 22.5, the tenth 3.0.
	 * Strictly between 0 and 1.
	 *
	 * The shape, not the number, is the point. A stopover's value does not grow linearly
	 * with its length: the second night in a city is a real gain over the first (one night
	 * is an overnight connection, two is a weekend), the tenth is barely different from the
	 * eighth, and past that the traveller has stopped having a stopover and started having
	 * a second holiday. Geometric decay is the cheapest curve with that shape — big early
	 * gains, a flat tail — and it needs one number rather than a table of breakpoints.
	 * 0.75 puts the knee where a stopover stops feeling like a trip of its own: nights one
	 * to four earn 40/30/22.5/17, nights nine to twelve earn 4.0/3.0/2.3/1.7.
	 *
	 * The bonus therefore has a ceiling of `firstNightBonus / (1 - decay)` = 160 points, so
	 * a per-night cost — a real bed's nightly rate, or
	 * `assumedNightCostWithoutPricedBed` below when no bed was priced — always overtakes it
	 * eventually. That is what makes a longer stay stop being better: the curve flattens
	 * and the cost does not. Thirty nights scores below ten for every itinerary, not only
	 * for the ones a stay provider happened to answer for.
	 *
	 * The same factor discounts free-time hours by which day of the stopover they fall on
	 * (`discountedUsableFreeHours`), for the same reason and to close the same hole: free
	 * time grows with the stopover too, so decaying the night bonus alone would have left
	 * roughly 22 unbounded points per night in `usableFreeTimeWeightPerHour`.
	 */
	stopoverDecayPerNight: number;

	/** Score gained per "usable" hour of free time (see usableFreeHours). Kept separate
	 * from the flat per-night bonus above because they reward different things: nights
	 * reward there being a stopover at all, this rewards that stopover's waking hours
	 * actually landing in the day rather than the middle of the night. Set to 1.5 so a
	 * full usable day (about 15 usable hours out of 24) is worth roughly half of one
	 * night's flat bonus — free time is good, but a bed to sleep in is what turns hours
	 * into a trip, so nights should still weigh more than hours. */
	usableFreeTimeWeightPerHour: number;

	/**
	 * Score charged per night of a stopover whose bed was never priced — no stay provider
	 * key configured, every provider out of quota or erroring, or nothing bookable found
	 * near the connection airport.
	 *
	 * Issue #167: without this, an unpriced night is scored as a free night. It is not
	 * free, it is unknown, and the two must not rank the same — otherwise the app rewards a
	 * stopover for the app's own ignorance about it, and every night of it looks like pure
	 * gain. The stated assumption is that a night in the stopover city costs about what a
	 * bed costs, and 30 is drawn from the only real quotes in this repo: the captured
	 * Agoda fixture for a London hostel dorm reads EUR 22.97 and EUR 25.53 a night
	 * (`providers/stays/fixtures/agoda-get-prices-hostelle-london-eur.json`), and the
	 * Booking one for an airport Ibis in Vienna reads EUR 65.45
	 * (`booking-search-vienna.json`). 30 sits deliberately above every hostel rate we have
	 * actually seen, so a stopover with a real cheap bed always beats an identical one with
	 * no bed at all, and below the hotel rate, so this stays an assumption about a budget
	 * traveller rather than a penalty dressed up as one.
	 *
	 * This is a SCORING charge only. It never reaches `Itinerary.totalPrice`, which keeps
	 * saying exactly what was actually quoted (AGENTS.md: "never present an estimate as a
	 * fact"). The traveller sees "no bed priced for this stopover" and a total without one;
	 * the ranking is what stops pretending that means zero.
	 */
	assumedNightCostWithoutPricedBed: number;

	/**
	 * Score charged for each unpriced ride on a ground leg whose fare nobody quoted. This is
	 * issue #204, and exactly the same argument `assumedNightCostWithoutPricedBed` above
	 * makes, pointed at the other cost this app cannot see.
	 *
	 * A taxi from the runway to a bed 40km away is not free, it is unknown, and until this
	 * existed the two ranked identically: `Itinerary.totalPrice` omits an unquoted fare
	 * (correctly, see its own doc comment), so a stopover reachable only by two taxi
	 * rides scored precisely as well as one you can walk. The owner met that as "the
	 * hotels found are TOO FAR away to be an acceptable result", and he was reading a
	 * ranking that had been told getting there cost nothing.
	 *
	 * A walk is never charged. Walking is free and that is a fact, not a gap
	 * (`domain/transfer.ts`'s `costIsUnknown`), so a bed you can reach on foot beats an
	 * identical one you cannot, which is the product thesis with a number on it.
	 *
	 * 3 is what any unpriced ride costs before it has gone anywhere: a taxi's flag-down, or
	 * a bus ticket. It is read off the low column of the EUR cards in
	 * `providers/transfers/taxi-rate-table.ts` (ES 2.15, PT 2.00, FR 2.60, DE 3.50,
	 * IT 3.00). `assumedRoadTransferCostPerHour` below is the rest of a taxi fare; a
	 * `transit` ride is charged this alone, because a train into town costs a ticket, not a
	 * meter.
	 *
	 * Charged per RIDE inside the leg, not once per leg, which is the owner's **"no
	 * transport hoping to change bus or metro line"** given a number. A ride is a
	 * `TransferLeg` whose mode is not `walk`, so a coach to the edge of town and then a
	 * metro is two boardings and two tickets, and it now costs twice what the direct metro
	 * costs. Charged once per leg the two came out identical, and nothing else in the model
	 * separates them. `Transfer.duration` covers both journeys equally well, and
	 * `Transfer.mode` says `transit` for each.
	 *
	 * Walking inside the leg still costs nothing, for the reason above. A walk to the stop
	 * is free and that is a fact, so a journey of walk, ride, walk costs one ticket rather
	 * than three. A leg with an empty `legs` array costs one, because a provider that
	 * itemised no rides did not thereby give us a free journey.
	 *
	 * Transport research measures a "pure transfer penalty" sitting on top of the walking
	 * and waiting a change costs, and puts it at 4 to 20 equivalent in-vehicle minutes
	 * across the literature, with a weighted average of 14 and a 13-to-18 range proposed
	 * for planning (Garcia-Martinez et al., "Transfer penalties in multimodal public
	 * transport networks", Transportation Research Part A,
	 * https://www.sciencedirect.com/science/article/abs/pii/S0965856417303117). That
	 * corroborates the direction and nothing more. This app charges a ticket per ride
	 * rather than a penalty in minutes, because the score is denominated in money and a
	 * ticket is a number this module can read off a rate card and defend. The 3 comes from
	 * the paragraph above. The literature does not set it.
	 *
	 * `assumedRoadTransferCostPerHour` below is unaffected. It is charged once against the
	 * whole leg's `duration` however many rides sit inside it, because it prices distance
	 * covered and a traveller who changes vehicles has not thereby travelled further.
	 *
	 * SCORING ONLY, like the night charge above. It never reaches `Itinerary.totalPrice`.
	 */
	assumedUnpricedTransferBaseCost: number;

	/**
	 * Charged on top of `assumedUnpricedTransferBaseCost`, per hour, for an unpriced leg
	 * taken by road in a private vehicle (`taxi` or `drive`). Issue #204.
	 *
	 * Distance is what the reported bug is actually about, so a flat per-leg charge does
	 * not fix it: at Gatwick the London bed is roughly 40km out and the Horley bed 3km,
	 * and a charge that cannot tell those apart leaves the cheaper distant bed winning
	 * exactly as before. Only a term that grows with the ride changes the answer.
	 *
	 * 70 is derived, not picked. Take the low per-km column of every card in
	 * `taxi-rate-table.ts`, put them all in euros so they can be compared at all, and sort:
	 * PT 0.90, CZ 1.00, FR 1.00, IT 1.10, ES 1.13, SE 1.32, AT 1.40, DE 1.70, BE 1.80,
	 * NL 2.10, GB 3.28, CH 3.75. The median is 1.36 per kilometre. An airport-to-city road
	 * route averages something near 50km/h once OSRM's car profile has been down a
	 * motorway and through a suburb, so 1.36 x 50 is about 70 an hour.
	 *
	 * The median rather than the floor, following the same reasoning
	 * `assumedNightCostWithoutPricedBed` gives for landing in the middle of its evidence:
	 * a number under every card charges a Swiss taxi Portuguese rates, which is not
	 * caution, it is a different wrong answer. One global figure cannot be right
	 * everywhere. It is wrong by about 2.5x in Britain and Switzerland and by about half
	 * in Portugal and Czechia, and that is the honest cost of a score denominated in one
	 * unit while fares are quoted in twelve currencies.
	 *
	 * It checks out against the table where the table is typical: a 12-minute, 10km hop
	 * costs 3 + 14 = 17 here against €13.50 from the Spanish card.
	 *
	 * `Transfer.duration` is the basis, and on the hotel-bound leg it carries the
	 * landing-to-transport buffer as well as the ride (`search/resources.ts`'s
	 * `applyLandingBuffer`), so that leg is overcharged by the 15 or 30 minutes it takes
	 * to get out of the terminal. That is a known, bounded error, and it cancels exactly
	 * where it matters: every candidate at one connection airport carries the same buffer,
	 * so it never decides between two beds at the same airport.
	 *
	 * The alternative was the measured fare this app already computes
	 * (`FareEstimate`, from a real OSRM distance). It is not usable here: it is
	 * denominated in the rate card's own country currency, GBP for a Gatwick layover,
	 * against a EUR-denominated score, and nothing in this codebase converts currencies by
	 * design. Folding GBP minor units into a EUR figure is the class of bug #152 fixed.
	 * The measured range still reaches the traveller, in its own currency and tagged as an
	 * estimate, in `TransportPicker`.
	 */
	assumedRoadTransferCostPerHour: number;

	/** Score lost per flight (0, 1, or 2 per itinerary) operated by an airline on the
	 * traveller's avoid list. Large enough (25 per flight) to reliably sink such an
	 * itinerary toward the bottom of the list, but deliberately finite: per the brief
	 * ("Still fetches, but grayed out and less score") this is a strong preference, not a
	 * filter, so a itinerary that is dramatically cheaper or has a much better stopover
	 * must still be able to outrank it. */
	avoidedAirlinePenaltyPerFlight: number;
}

/**
 * The road speed `assumedRoadTransferCostPerHour` above is denominated against: what an
 * airport-to-city car route averages once OSRM's profile has been down a motorway and
 * through a suburb. It is half of that figure's derivation (median 1.36 a kilometre times
 * 50 an hour), and it is exported because `stays/stopover-cost.ts` has the other half of
 * the problem.
 *
 * That module ranks beds before any of them has been routed, so it holds a distance and no
 * duration, and dividing the hourly charge by this speed turns it back into the
 * per-kilometre figure the taxi table actually contains. Derived rather than restated, so
 * retuning the weight above cannot leave two modules charging different amounts for the
 * same ride. Issue #219.
 */
export const ASSUMED_ROAD_TRANSFER_KM_PER_HOUR = 50;

/** See each field's comment above for why that specific number. */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
	pricePerCurrencyUnit: 1,
	travelTimeWeightPerHour: 0.5,
	airportWaitingWeightPerHour: 2,
	firstNightBonus: 40,
	stopoverDecayPerNight: 0.75,
	usableFreeTimeWeightPerHour: 1.5,
	assumedNightCostWithoutPricedBed: 30,
	assumedUnpricedTransferBaseCost: 3,
	assumedRoadTransferCostPerHour: 70,
	avoidedAirlinePenaltyPerFlight: 25
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Each factor's raw contribution to the total, in the same euro-equivalent points as the
 * total itself, so the UI can show a traveller why an itinerary ranked where it did
 * instead of just the final number. */
export interface ScoreBreakdown {
	price: number;
	travelTime: number;
	airportWaiting: number;
	/** The saturating night bonus (`nightBonus`), always >= 0. */
	nights: number;
	usableFreeTime: number;
	/** Issue #167: what this stopover's nights are charged when no bed was priced for them,
	 * always <= 0 and always 0 when `Itinerary.stay` is present — the real nightly rate is
	 * already inside `price` in that case. Separate from `nights` so a breakdown can show
	 * "3 nights, none of them priced" as two honest numbers rather than one netted-out one. */
	unpricedNights: number;
	/** Issue #204: what this trip's ground legs are charged when no provider quoted their
	 * fare, always <= 0 and 0 for a trip whose every leg is either walked or priced.
	 * Separate from `price` so a breakdown can show "EUR 238 quoted, two rides nobody
	 * priced" as two honest numbers rather than one blended one. */
	unpricedTransfers: number;
	avoidedAirline: number;
}

export interface ItineraryScore {
	itinerary: Itinerary;
	/** Sum of every field in breakdown. Higher is better; the number is only meaningful
	 * relative to other scores from the same search (same currency, same weights). */
	total: number;
	breakdown: ScoreBreakdown;
	/** 0, 1, or 2 — how many of this itinerary's flights are on the avoid list. Exposed
	 * so the UI can grey the card out per the brief without re-deriving carrier membership
	 * itself; never used here to remove the itinerary, only to penalise its score. */
	avoidedAirlineFlightCount: number;
}

/**
 * Price in major units, scaled by the currency's own exponent (`majorUnitsOf`,
 * domain/money.ts). Ranking would survive a wrong scale — one search shares one currency,
 * so every itinerary would be wrong by the same factor — but the weights below are
 * calibrated in units of "one euro of price against one minute of time", and a yen total
 * read as if it had cents would make price weigh a hundredth of what it should against
 * duration. Issue #179.
 */
function priceInMajorUnits(itinerary: Itinerary): number {
	return majorUnitsOf(itinerary.totalPrice);
}

function countAvoidedAirlineFlights(
	itinerary: Itinerary,
	airlinesToAvoid: readonly IataAirlineCode[]
): number {
	if (airlinesToAvoid.length === 0) return 0;
	const avoided = new Set(airlinesToAvoid.map((code) => code.toUpperCase()));
	const legs = [itinerary.outboundFlight, itinerary.onwardFlight];
	return legs.filter((flight) => avoided.has(flight.carrier.iataCode.toUpperCase())).length;
}

/**
 * Scores one itinerary. Never filters anything — per the brief, an avoided airline "still
 * fetches, but grayed out and less score", so the only effect it has here is the
 * avoidedAirline penalty below, never exclusion from the result.
 */
export function scoreItinerary(
	itinerary: Itinerary,
	airlinesToAvoid: readonly IataAirlineCode[] = [],
	weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ItineraryScore {
	// times.total covers door-to-door including the free time in the connection city;
	// subtracting free time leaves exactly the overhead a traveller would rather not have
	// — both flights, both airport waits, and every transfer leg.
	const travelBurdenHours = (itinerary.times.total - itinerary.times.free) / 60;
	const airportWaitingHours = itinerary.times.airportWaiting / 60;
	const usableHours = discountedUsableFreeHours(itinerary.freeTime, weights.stopoverDecayPerNight);
	const avoidedAirlineFlightCount = countAvoidedAirlineFlights(itinerary, airlinesToAvoid);
	const nights = Math.max(0, itinerary.nightsInConnection);
	// Issue #167: a bed quoted at zero is a provider defect, not a free room, so it is
	// scored the same as no quote at all. Without that reading, a single zero-priced stay
	// would restore the exact runaway this change exists to remove: nothing at all would
	// charge for its nights, and a saturating bonus that never quite reaches its ceiling
	// would keep making one more night marginally better, forever.
	const bedPriced = (itinerary.stay?.pricePerNight.minorUnits ?? 0) > 0;
	// Issue #204. Derived from the itinerary's own legs rather than a stored field, so a
	// picker swap or a waiting-time edit cannot leave this disagreeing with the trip it
	// describes. See `unpricedTransferLegs`' own doc comment.
	const unpricedTransferCost = unpricedTransferLegs(itinerary).reduce((charge, { transfer }) => {
		// Every boarding buys its own ticket or flag-down, so a coach then a metro costs
		// twice a direct metro; the walks between them are free and stay uncounted. A leg
		// that lists no rides at all is still one fare, never zero.
		const rides = Math.max(1, transfer.legs.filter((leg) => leg.mode !== 'walk').length);
		// Only a private vehicle then keeps charging by the kilometre, which `duration`
		// stands in for, and it charges for the whole leg once however many rides it holds.
		const road = transfer.mode === 'taxi' || transfer.mode === 'drive';
		return (
			charge +
			weights.assumedUnpricedTransferBaseCost * rides +
			(road ? (weights.assumedRoadTransferCostPerHour * transfer.duration) / 60 : 0)
		);
	}, 0);

	const breakdown: ScoreBreakdown = {
		price: -weights.pricePerCurrencyUnit * priceInMajorUnits(itinerary),
		travelTime: -weights.travelTimeWeightPerHour * travelBurdenHours,
		airportWaiting: -weights.airportWaitingWeightPerHour * airportWaitingHours,
		nights: nightBonus(nights, weights.firstNightBonus, weights.stopoverDecayPerNight),
		usableFreeTime: weights.usableFreeTimeWeightPerHour * usableHours,
		// The `=== 0 ? 0 :` guard is the same -0 avoidance `avoidedAirline` below uses.
		unpricedNights:
			bedPriced || nights === 0 ? 0 : -weights.assumedNightCostWithoutPricedBed * nights,
		// Same `=== 0 ? 0 :` -0 guard as the two charges either side of it.
		unpricedTransfers: unpricedTransferCost === 0 ? 0 : -unpricedTransferCost,
		// The `=== 0 ? 0 :` guard avoids producing -0 for the common case of no avoided
		// flights, which would otherwise print as "-0" anywhere this breakdown is shown.
		avoidedAirline:
			avoidedAirlineFlightCount === 0
				? 0
				: -weights.avoidedAirlinePenaltyPerFlight * avoidedAirlineFlightCount
	};

	const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0);

	return { itinerary, total, breakdown, avoidedAirlineFlightCount };
}

/**
 * Scores every itinerary and sorts best-first. Avoided-airline itineraries are always
 * present in the output at the same length as the input — the brief is explicit that they
 * "still fetch", so dropping them here would be a bug, not an optimisation.
 */
export function rankItineraries(
	itineraries: readonly Itinerary[],
	airlinesToAvoid: readonly IataAirlineCode[] = [],
	weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ItineraryScore[] {
	return itineraries
		.map((itinerary) => scoreItinerary(itinerary, airlinesToAvoid, weights))
		.sort((a, b) => b.total - a.total);
}

/**
 * What one trip costs the traveller in money, in the same major units the weights above
 * are denominated in. Issue #364.
 *
 * Two terms, not one. `price` is what providers actually quoted. `unpricedNights` is what
 * this trip's nights cost when nobody priced a bed for them, charged at
 * `assumedNightCostWithoutPricedBed`. A comparison between two stopover lengths needs both
 * or it is not a comparison: `Itinerary.totalPrice` leaves a bed out entirely when no stay
 * provider answered, so a three-night pairing would come out cheaper than a same-day one
 * purely because the app never learned what three beds cost. That is the app being rewarded
 * for its own ignorance, which is the exact defect issue #167 added the charge for.
 *
 * Everything else in the breakdown is deliberately absent. The night bonus, the free-time
 * bonus and the travel-time charges are the app's opinion about how good a trip is; this is
 * what the trip costs. Issue #230 took that opinion out of the choice of stopover length
 * and it stays out. Unpriced transfers are out too: they are the same legs at every length
 * through one city, so folding them in would make a length choice turn on which day's route
 * happened to get routed.
 */
export function moneyCostOf(score: ItineraryScore): number {
	return -(score.breakdown.price + score.breakdown.unpricedNights);
}
