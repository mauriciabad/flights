/**
 * What one bed really costs a stopover. The number the app ranks beds on, and nothing a
 * traveller ever sees.
 *
 * ## The journeys a stopover makes
 *
 * A stopover travels to the airport twice, always, and into the city centre and back once
 * per day it can actually use the city. So a bed costs the room for its nights, plus one
 * round trip between the bed and the connection airport, plus one round trip between the
 * bed and the centre for every usable day.
 *
 * The airport legs are the whole story for a stopover whose free time is a night's sleep
 * between two flights, and `visitDays` is zero there. That is the stopover issue #219 is
 * about, the one that lands at half past eleven at night. Two free days is a different bed
 * entirely. The traveller makes two more round trips into town, and a bed 6 km from the
 * centre charges him for both while a bed beside the cathedral does not.
 *
 * ## Why price alone could never get this right
 *
 * Issue #219. `rank.ts` and `search/resources.ts` both ordered by `pricePerNight` alone. A
 * dorm bed in a big city is structurally cheaper than a private room beside a runway, so
 * with a 50 km radius the cheapest bed is essentially always the far one. On the owner's
 * own route the app picked a EUR 13.00/night bed **48.3 km** out, reached by a walk, a bus
 * and two metros, over a EUR 52.82/night room 2.8 km from the terminal. His words:
 *
 * > the hotels found are TOO FAR away to be an acceptable result
 *
 * `search/resources.ts`' own radius comment had already worked out that no radius separates
 * them. Gatwick to central London is 40.1 km and Malpensa to central Milan is 40.4, and one
 * of those is the product working. It named the separator too: "the cost of getting there".
 *
 * ## Why the fare cannot be used, and what stands in for it
 *
 * Issue #212: no `TransferProvider` in this codebase quotes a ground fare, so the card
 * already says "excludes unpriced ground transport" and there is no number to add.
 *
 * `algorithm/score.ts` met the same wall for issue #204 and answered it with an assumption
 * it argues at length: an unpriced leg costs `assumedUnpricedTransferBaseCost` before it has
 * gone anywhere, plus `assumedRoadTransferCostPerHour` for a private vehicle. This module
 * reuses both rather than inventing a second opinion about what a ride costs. It has to turn
 * the hourly figure back into the per-kilometre one it was built from, because a bed is
 * ranked before anything has routed to it, so a straight line is all there is.
 * `ASSUMED_ROAD_TRANSFER_KM_PER_HOUR` is exported from `score.ts` for exactly that.
 *
 * ## What that charges, and what it gets wrong
 *
 * About 1.40 a kilometre each way. That is a taxi, and it over-charges a train: Gatwick to
 * central London is a 12-pound ticket and this calls it about 68. The direction is chosen,
 * not accidental. Charging a bus ticket instead would be a flat per-leg figure, and a flat
 * figure cannot tell 2.8 km from 48.3 km, which is the entire defect. It is also the mode
 * you actually take at half past eleven at night with a suitcase, which is when the
 * offending stopover lands.
 *
 * A walkable bed is charged a ride it would not take. `domain/transfer.ts` is clear that
 * walking is free and that this is a fact rather than a gap, so that is a real inaccuracy,
 * and a bounded one, worth about 14 at 2.8 km, far too small to decide between two beds.
 *
 * The centre legs are charged at that same rate and inherit that same over-charge, with more
 * force. A trip into town in daylight is the one most likely to be a metro ride, and this
 * bills it as a taxi. The rate is reused rather than replaced because a second per-kilometre
 * opinion is how two modules come to charge different amounts for the same ride, which is
 * the argument this module already makes for taking `score.ts`' figures instead of deriving
 * its own.
 *
 * One error is the centre legs' alone. The journey in from the airport usually passes
 * through the centre on the way, so a bed near the centre is credited slightly twice for the
 * same stretch of road. It is bounded by the same per-kilometre rate as everything else
 * here, and two beds the same distance from the centre are credited identically, so it never
 * decides between them.
 *
 * Ranking only. Not one unit of this reaches `Itinerary.totalPrice`, which keeps saying
 * exactly what was quoted (AGENTS.md: "never present an estimate as a fact").
 *
 * ## The crossover, which is the part worth checking
 *
 * The room is charged per night and the airport ride is charged twice, full stop, so the far
 * bed wins as soon as the stopover is long enough for the nightly saving to pay for the
 * journey. On the measured London list that is between three and four nights: one night
 * beside the terminal, four nights in town. Which is the product answering the question the
 * right way round rather than a penalty pointed at cities.
 *
 * Days out have a crossover of their own and it arrives sooner, because each day is charged
 * in full while the saving that pays for it only accrues per night. On the same London list,
 * one night and one day out still leaves the room beside the terminal ahead, and the second
 * day hands the list to the bed near the centre.
 */

import { ASSUMED_ROAD_TRANSFER_KM_PER_HOUR, DEFAULT_SCORING_WEIGHTS } from '$lib/algorithm/score';
import type { Coordinates, Stay } from '$lib/domain';
import { minorUnitsPerMajorUnit } from '$lib/domain';
import { haversineDistanceKm } from './distance';

/** Charged once per leg before the leg has gone anywhere: a flag-down, or a ticket. */
const REACH_BASE_COST_MAJOR_UNITS = DEFAULT_SCORING_WEIGHTS.assumedUnpricedTransferBaseCost;

/** And this much per straight-line kilometre, twice, because the traveller comes back. */
const REACH_COST_PER_KM_MAJOR_UNITS =
	DEFAULT_SCORING_WEIGHTS.assumedRoadTransferCostPerHour / ASSUMED_ROAD_TRANSFER_KM_PER_HOUR;

/**
 * Getting from a property out to `destination` and back, in minor units of `currency`, from
 * the straight line between the two. The connection airport for the legs every stopover
 * makes, the city centre for the ones a day out adds.
 *
 * Denominated in whatever the search is priced in, while the rate card behind the figure is
 * in euros. `score.ts` documents that compromise for the same number and it is the same
 * compromise here: nothing in this codebase converts currencies, by design, and a constant
 * applied to every candidate at one airport shifts a ranking far less than a currency
 * conversion nobody asked for would.
 */
export function reachCostMinorUnits(
	property: Coordinates,
	destination: Coordinates,
	currency: string
): number {
	const km = haversineDistanceKm(property, destination);
	const oneWay = REACH_BASE_COST_MAJOR_UNITS + km * REACH_COST_PER_KM_MAJOR_UNITS;
	return Math.round(2 * oneWay * minorUnitsPerMajorUnit(currency));
}

/** What a stopover asks of a bed. */
export interface StopoverJourneys {
	/** Where both airport legs begin and end. */
	connectionAirport: Coordinates;
	/**
	 * The stopover city's own centre, absent when this airport has no city point.
	 * `City.coordinates` is optional and `data/airport-city-names.ts` is explicit that "the
	 * airport will do" is never an answer, so absent means the centre term is zero. That is
	 * silence rather than a guess.
	 */
	cityCentre?: Coordinates;
	/** `Itinerary.nightsInConnection`. */
	nights: number;
	/**
	 * Days the traveller can actually use the city, and therefore round trips into its
	 * centre. Zero for a stopover whose free time is a night's sleep between two flights.
	 */
	visitDays: number;
}

/**
 * The whole cost of choosing this bed for this stopover, in minor units of its own
 * currency: `nights` at its nightly rate, one round trip to the airport, and one round trip
 * into the centre per usable day.
 *
 * Comparable across properties only within one connection and one currency, which is the
 * only place any caller uses it. `search/resources.ts` filters mismatched currencies out
 * before ranking (issue #152) and the picker's list is one connection's.
 */
export function stopoverStayCostMinorUnits(stay: Stay, stopover: StopoverJourneys): number {
	const { currency } = stay.pricePerNight;
	const property = stay.property.coordinates;
	const room = stay.pricePerNight.minorUnits * Math.max(0, stopover.nights);
	const toAirport = reachCostMinorUnits(property, stopover.connectionAirport, currency);
	const intoTown =
		stopover.cityCentre && stopover.visitDays > 0
			? stopover.visitDays * reachCostMinorUnits(property, stopover.cityCentre, currency)
			: 0;
	return room + toAirport + intoTown;
}

/**
 * The night count `search/resources.ts` ranks against, before any flight pairing exists.
 *
 * One. The stay search runs for the whole date window in parallel with the flights, so the
 * real length is not known yet and the window's own span (six nights, on the owner's route)
 * is the trip, not the stopover. One is the honest stand-in since issue #230: every card
 * opens on the shortest pairing that city can do, and that is the trip whose total the
 * traveller compares cities on, so it is the trip the default bed should suit.
 *
 * The picker re-ranks with the real `nightsInConnection` the moment a card is opened, which
 * is also the moment a longer stay is on screen, so a traveller who extends to four nights
 * in London sees the city dorm climb back to the top of the list, and one tap moves the
 * total to it.
 */
export const NIGHTS_ASSUMED_BEFORE_A_PAIRING_EXISTS = 1;

/**
 * The day count `search/resources.ts` ranks against, for the same reason and at the same
 * moment.
 *
 * Zero. There is no pairing yet, so there is no free-time window to count days in, and any
 * other number would be this module asserting a day out that nothing has offered anybody.
 * Zero is the only value that claims nothing: it charges the two airport legs every stopover
 * makes and adds no journey on top of them.
 *
 * The picker re-ranks with the real count the moment a card opens, which is also the moment
 * the free time is on screen. The traveller sees the list pull toward the centre while the
 * days that pay for it are in front of him.
 */
export const VISIT_DAYS_ASSUMED_BEFORE_A_PAIRING_EXISTS = 0;
