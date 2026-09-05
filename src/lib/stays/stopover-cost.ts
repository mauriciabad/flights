/**
 * What one bed really costs a stopover: the room for its nights, plus getting out to it
 * and back once. The number the app ranks beds on, and nothing a traveller ever sees.
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
 * them — Gatwick to central London is 40.1 km and Malpensa to central Milan is 40.4, and one
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
 * ranked before anything has routed to it, so a straight line is all there is —
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
 * walking is free and that this is a fact rather than a gap, so that is a real inaccuracy —
 * and a bounded one, worth about 14 at 2.8 km, far too small to decide between two beds.
 *
 * Ranking only. Not one unit of this reaches `Itinerary.totalPrice`, which keeps saying
 * exactly what was quoted (AGENTS.md: "never present an estimate as a fact").
 *
 * ## The crossover, which is the part worth checking
 *
 * The room is charged per night and the ride is charged twice, full stop, so the far bed
 * wins as soon as the stopover is long enough for the nightly saving to pay for the journey.
 * On the measured London list that is between three and four nights: one night beside the
 * terminal, four nights in town. Which is the product answering the question the right way
 * round rather than a penalty pointed at cities.
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
 * Getting out to a property and back, in minor units of `currency`, from the straight line
 * between it and the connection airport.
 *
 * Denominated in whatever the search is priced in, while the rate card behind the figure is
 * in euros. `score.ts` documents that compromise for the same number and it is the same
 * compromise here: nothing in this codebase converts currencies, by design, and a constant
 * applied to every candidate at one airport shifts a ranking far less than a currency
 * conversion nobody asked for would.
 */
export function reachCostMinorUnits(
	property: Coordinates,
	connectionAirport: Coordinates,
	currency: string
): number {
	const km = haversineDistanceKm(property, connectionAirport);
	const oneWay = REACH_BASE_COST_MAJOR_UNITS + km * REACH_COST_PER_KM_MAJOR_UNITS;
	return Math.round(2 * oneWay * minorUnitsPerMajorUnit(currency));
}

/**
 * The whole cost of choosing this bed for this stopover, in minor units of its own
 * currency: `nights` at its nightly rate, plus one round trip to reach it.
 *
 * Comparable across properties only within one connection and one currency, which is the
 * only place either caller uses it. `search/resources.ts` filters mismatched currencies out
 * before ranking (issue #152) and the picker's list is one connection's.
 */
export function stopoverStayCostMinorUnits(
	stay: Stay,
	connectionAirport: Coordinates,
	nights: number
): number {
	const room = stay.pricePerNight.minorUnits * Math.max(0, nights);
	return room + reachCostMinorUnits(stay.property.coordinates, connectionAirport, stay.pricePerNight.currency);
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
 * is also the moment a longer stay is on screen — so a traveller who extends to four nights
 * in London sees the city dorm climb back to the top of the list, and one tap moves the
 * total to it.
 */
export const NIGHTS_ASSUMED_BEFORE_A_PAIRING_EXISTS = 1;
