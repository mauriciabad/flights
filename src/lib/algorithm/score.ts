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
import type { FreeTime, Itinerary } from '../domain/itinerary';

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

	/** Score gained per night actually spent in the connection city. This is the product
	 * thesis, so it is deliberately the single biggest number in this config: set to 40 so
	 * that three nights (120 points) comfortably outweighs an eight-euro price gap — the
	 * exact trade the brief itself describes — while still losing to a price difference in
	 * the hundreds. */
	nightBonusPerNight: number;

	/** Score gained per "usable" hour of free time (see usableFreeHours). Kept separate
	 * from the flat per-night bonus above because they reward different things: nights
	 * reward there being a stopover at all, this rewards that stopover's waking hours
	 * actually landing in the day rather than the middle of the night. Set to 1.5 so a
	 * full usable day (about 15 usable hours out of 24) is worth roughly half of one
	 * night's flat bonus — free time is good, but a bed to sleep in is what turns hours
	 * into a trip, so nights should still weigh more than hours. */
	usableFreeTimeWeightPerHour: number;

	/** Score lost per flight (0, 1, or 2 per itinerary) operated by an airline on the
	 * traveller's avoid list. Large enough (25 per flight) to reliably sink such an
	 * itinerary toward the bottom of the list, but deliberately finite: per the brief
	 * ("Still fetches, but grayed out and less score") this is a strong preference, not a
	 * filter, so a itinerary that is dramatically cheaper or has a much better stopover
	 * must still be able to outrank it. */
	avoidedAirlinePenaltyPerFlight: number;
}

/** See each field's comment above for why that specific number. */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
	pricePerCurrencyUnit: 1,
	travelTimeWeightPerHour: 0.5,
	airportWaitingWeightPerHour: 2,
	nightBonusPerNight: 40,
	usableFreeTimeWeightPerHour: 1.5,
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
	nights: number;
	usableFreeTime: number;
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
 * Price is read directly off Money.minorUnits / 100 rather than through a currency-aware
 * minor-unit table. That is exact for EUR/USD/GBP, the currencies every provider this app
 * targets actually quotes in, and wrong by a factor of 100 for a zero-decimal currency
 * like JPY. Scoring only ever compares itineraries from one search against each other, and
 * a single search shares one currency, so a wrong absolute scale would still rank
 * correctly — but the number would look strange in a debug view. Worth fixing only if a
 * zero-decimal currency provider actually gets added; not guessed at here.
 */
function priceInMajorUnits(itinerary: Itinerary): number {
	return itinerary.totalPrice.minorUnits / 100;
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
	const usableHours = usableFreeHours(itinerary.freeTime);
	const avoidedAirlineFlightCount = countAvoidedAirlineFlights(itinerary, airlinesToAvoid);

	const breakdown: ScoreBreakdown = {
		price: -weights.pricePerCurrencyUnit * priceInMajorUnits(itinerary),
		travelTime: -weights.travelTimeWeightPerHour * travelBurdenHours,
		airportWaiting: -weights.airportWaitingWeightPerHour * airportWaitingHours,
		nights: weights.nightBonusPerNight * itinerary.nightsInConnection,
		usableFreeTime: weights.usableFreeTimeWeightPerHour * usableHours,
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
