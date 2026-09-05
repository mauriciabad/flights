/**
 * Which bed this app recommends for one stopover, in one function.
 *
 * Issue #367. `StayPicker.svelte` has ranked its own list since issue #219 and the
 * results page now has to answer the same question when a nights change re-optimises the
 * bed. Two derivations of "the best bed" would drift within a day: the list on screen
 * would put one property first while the trip booked another, and the panel would be
 * announcing a swap to a bed the list disagrees with.
 *
 * The ranking itself stays in `rank.ts`. This is only the last step of it, the one both
 * callers were about to write separately.
 */

import type { Airport, Itinerary, Stay } from '$lib/domain';
import { visitDaysOf } from '$lib/components/free-time-days';
import { cheapestSelectableOption, rankProperties } from './rank';
import type { StopoverForRanking } from './rank';
import { groupByProperty } from './types';
import type { PropertyStayOptions } from './types';

/**
 * The bed to open a stopover on, out of everything the stay providers returned for it.
 *
 * `undefined` when nothing here is bookable by this group, which is the women-only-dorms
 * case `StayPicker` prints its own empty state for rather than falling back to a room
 * nobody in the party can sleep in.
 */
export function recommendedStay(
	candidates: readonly Stay[],
	stopover: StopoverForRanking
): Stay | undefined {
	const ranked = rankProperties(groupByProperty(candidates), stopover);
	return firstBookableStay(ranked, stopover.travellers, stopover.females);
}

/**
 * The same answer for a caller that has already ranked, which `StayPicker` has: it draws
 * the whole ordered list and would otherwise rank a second time to learn its own head.
 *
 * Walks past a group with nothing selectable rather than giving up on it. `rankProperties`
 * sorts those last, so this only ever matters when every property is one, and then the
 * answer is `undefined` either way.
 */
export function firstBookableStay(
	ranked: readonly PropertyStayOptions[],
	travellers: number | undefined,
	females: number | undefined
): Stay | undefined {
	for (const group of ranked) {
		const cheapest = cheapestSelectableOption(group, travellers, females);
		if (cheapest) return cheapest.stay;
	}
	return undefined;
}

/**
 * What one trip asks of a bed, in the shape `rankProperties` reads.
 *
 * Built in one place because the panel's list, the panel's "use the recommended bed" and
 * the page's re-rank on a nights change have to be asking the same question. The quickest
 * way for them to stop is for two of them to count the days out differently, or for one to
 * measure from the runway and another from the city.
 */
export function stopoverForRanking(
	itinerary: Itinerary,
	connectionAirport: Airport,
	travellers?: number,
	females?: number
): StopoverForRanking {
	return {
		travellers,
		females,
		connectionAirport: connectionAirport.coordinates,
		cityCentre: connectionAirport.city.coordinates,
		nights: itinerary.nightsInConnection,
		visitDays: visitDaysOf(itinerary)
	};
}
