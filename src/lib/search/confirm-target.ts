/**
 * The one definition of what a confirm-tier widen asks for, read by both the side that
 * quotes its price and the side that spends it.
 *
 * Issue #244: those two sides used to compute the request separately and disagree.
 * `pipeline.ts`'s `confirmWidenOptions` priced the query's whole date range, so the
 * acceptance search quoted 11 requests a stopover and 55 across five of them, over every
 * cap this app has. `+page.svelte` then narrowed the outbound leg to the single date
 * already on screen before spending, so pressing the row would have cost 8 a stopover, not
 * 11. Nobody could press it: the panel disables a row whose quoted cost exceeds the
 * remaining allowance, and 55 exceeds Sky Scrapper's 15 and Flights Sky's 40. A provider
 * the owner called non-negotiable was unreachable by any search, on a number describing a
 * request the app never makes.
 *
 * docs/PROVIDERS.md settled what the request should be long before either side was
 * written: "Skyscanner is spent, deliberately and visibly, on that one route and date."
 * One date, on each of the two legs. `confirmTargetFor` is that sentence as code, and
 * `narrowToConfirmTarget` is how a `SearchQuery` gets restricted to it, so an estimate and
 * a spend derived from the same target cannot quote different numbers.
 */

import type { IataAirportCode, IsoCalendarDate, Itinerary, SearchQuery } from '../domain';
import type { WidenTarget } from './types';

/**
 * The confirm target for one stopover: the exact date each of its two legs departs.
 *
 * With an `itinerary`, both dates come off the flights already on screen, which is what
 * the panel's own copy promises ("spends a real request to price the date already
 * shown"). Without one — a candidate the free tier ranked but never priced, which is every
 * candidate on issue #115's fallback sweep — they fall back to the query's soonest
 * acceptable dates. That is a probe rather than a confirmation, and it is still one date
 * per leg, so it costs the same and can never widen into the date fan-out
 * docs/PROVIDERS.md calls "broken by construction".
 */
export function confirmTargetFor(
	candidateAirportCode: IataAirportCode,
	query: SearchQuery,
	itinerary?: Itinerary
): WidenTarget {
	const outbound = departureDate(itinerary?.outboundFlight.departure.local) ?? query.soonestDeparture;
	const onward =
		departureDate(itinerary?.onwardFlight.departure.local) ?? query.soonestArrival ?? query.soonestDeparture;
	return {
		candidateAirportCode,
		outboundDeparture: { earliest: outbound, latest: outbound },
		onwardDeparture: { earliest: onward, latest: onward }
	};
}

/**
 * The query `widenSearch` runs one target under, and the query `confirmWidenOptions`
 * prices it against. All four date fields, not two: `onwardLegQuery` reads the arrival
 * pair, so leaving those alone left the onward leg spanning the trip's whole arrival
 * window while a comment three lines up claimed the range had been narrowed (issue #244).
 *
 * Narrowing `latestArrival` also tightens the stay lookup's check-out
 * (`processCandidate`'s `checkOut`) from the last day of the trip to the day the traveller
 * flies out of the stopover, which is the night count they actually booked — the same
 * correction issues #224 and #231 made for the free tier.
 */
export function narrowToConfirmTarget(query: SearchQuery, target: WidenTarget): SearchQuery {
	return {
		...query,
		soonestDeparture: target.outboundDeparture.earliest,
		latestDeparture: target.outboundDeparture.latest,
		soonestArrival: target.onwardDeparture.earliest,
		latestArrival: target.onwardDeparture.latest
	};
}

function departureDate(local: string | undefined): IsoCalendarDate | undefined {
	return local === undefined ? undefined : local.slice(0, 10);
}
