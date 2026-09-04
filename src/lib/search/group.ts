/**
 * Issue #56's last algorithm step: "group variants of the same itinerary." `build.ts`
 * produces one `Itinerary` per (outbound offer, onward offer) pair sharing a connection
 * airport — a candidate with three plausible outbound flights and two onward ones yields six
 * `Itinerary` records, all of them the same underlying trip idea ("stop over in Vienna") at
 * different times or fares. Brief line 67: "user can see alternative flights for same
 * location with their price and difference from selected one, selecting updates ui" — that
 * needs the alternates kept together, not flattened into six competing rows.
 */

import type { ItineraryGroup, ItineraryResult } from './types';

/**
 * Groups by connection airport code (`outboundFlight.arrivalAirport`, the one field every
 * variant through the same stopover shares), sorts each group's variants best score first,
 * and sorts the groups themselves by their best variant — so the result is ready to render
 * top-to-bottom with no further sorting.
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
		variants.sort((a, b) => b.score.total - a.score.total);
		groups.push({ connectionAirportCode, best: variants[0], variants });
	}

	groups.sort((a, b) => b.best.score.total - a.best.score.total);
	return groups;
}
