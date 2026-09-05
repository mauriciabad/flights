/**
 * Issue #56's last algorithm step: "group variants of the same itinerary." `build.ts`
 * produces one `Itinerary` per (outbound offer, onward offer) pair sharing a connection
 * airport — a candidate with three plausible outbound flights and two onward ones yields six
 * `Itinerary` records, all of them the same underlying trip idea ("stop over in Vienna") at
 * different times or fares. Brief line 67: "user can see alternative flights for same
 * location with their price and difference from selected one, selecting updates ui" — that
 * needs the alternates kept together, not flattened into six competing rows.
 */

import { moneyCostOf } from '../algorithm/score';
import { defaultStopover } from '../algorithm/stopover-length';
import type { ItineraryGroup, ItineraryResult } from './types';

/**
 * Groups by connection airport code (`outboundFlight.arrivalAirport`, the one field every
 * variant through the same stopover shares), sorts each group's variants best score first,
 * and sorts the groups themselves by their `best`, so the result is ready to render
 * top-to-bottom with no further sorting.
 *
 * Issue #224: `best` is not the highest-scoring variant. `score.ts` pays for nights, so the
 * top score through a city was always its longest pairing, and a 6-to-12 October search came
 * back with six nights beside Gatwick while the one-night trip sat in the same `variants`
 * array unseen. Issue #364 then settled which of the lengths it is: the cheapest one, ties
 * to the shortest stay. See `algorithm/stopover-length.ts` for the rule and the owner's own
 * words.
 *
 * That also decides the ORDER of the groups, and deliberately. Sorting cities by their
 * longest pairing compared stopover lengths as much as prices: a EUR 13/night dorm 48km out
 * beat a EUR 53/night room 2.8km from the terminal because one card was charging six nights
 * and the other one. Every group is now ranked at the length its card actually shows.
 */
export function groupItineraryResults(results: readonly ItineraryResult[]): ItineraryGroup[] {
	const byConnection = new Map<string, ItineraryResult[]>();
	for (const result of results) {
		const code = result.score.itinerary.outboundFlight.arrivalAirport;
		const existing = byConnection.get(code);
		if (existing) existing.push(result);
		else byConnection.set(code, [result]);
	}

	const groups: ItineraryGroup[] = [];
	for (const [connectionAirportCode, variants] of byConnection) {
		// Score order first, so `defaultStopover` picking the FIRST variant at each length
		// picks that length's best pairing rather than an arbitrary one, and so the flight
		// pickers still list alternatives best-first.
		variants.sort((a, b) => b.score.total - a.score.total);
		const best =
			defaultStopover(
				variants,
				(variant) => variant.score.itinerary.nightsInConnection,
				(variant) => moneyCostOf(variant.score)
			) ?? variants[0];
		groups.push({ connectionAirportCode, best, variants });
	}

	groups.sort((a, b) => b.best.score.total - a.best.score.total);
	return groups;
}
