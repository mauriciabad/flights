/**
 * The one journey `pnpm qa` drives, and the route graph the bench answers with.
 *
 * Shaped after docs/ACCEPTANCE.md's own test — an origin and a destination with no direct
 * route between them, a handful of real stopover cities, and a week to spend. The airports
 * are European Ryanair bases rather than BVC/PFO because Ryanair genuinely does not serve
 * BVC (docs/ACCEPTANCE.md records an agent inventing exactly that itinerary), and a harness
 * that asks a recorded provider to answer for a route the real one 404s would be teaching
 * the wrong lesson.
 */

import type { IataAirportCode } from '../../../src/lib/domain';

export const ORIGIN: IataAirportCode = 'BCN' as IataAirportCode;
export const DESTINATION: IataAirportCode = 'TLL' as IataAirportCode;

/** The route graph below deliberately gives the origin no direct hop to the destination:
 * the whole product is stopovers on routes with no direct flight, so a pair that already
 * has one exercises the "well served direct" empty state instead of the app. */
export const EARLIEST_DEPARTURE = '2026-10-06';
export const LATEST_ARRIVAL = '2026-10-12';

/**
 * Who flies where, as the bench will answer it. This is the ground truth
 * `no-fabricated-flights.qa.ts` holds the app to: an offer on a pair that is not in here
 * came from nowhere a provider spoke.
 */
export const ROUTE_GRAPH: Readonly<Record<string, readonly string[]>> = {
	BCN: ['VIE', 'BGY', 'WAW', 'CRL', 'STN'],
	VIE: ['TLL', 'BCN', 'STN'],
	BGY: ['TLL', 'BCN'],
	WAW: ['TLL', 'BCN'],
	CRL: ['TLL', 'BCN'],
	STN: ['VIE', 'BCN'],
	TLL: ['VIE', 'BGY', 'WAW', 'CRL']
};

/** Every airport the scenario can name, with the timezone Ryanair's active-airports
 * endpoint is the only source for — `ryanair-mapper.ts` drops an offer whose airports it
 * cannot place in a timezone, so a missing entry here reads as "no flights" rather than as
 * the fixture gap it is. */
export const AIRPORT_TIME_ZONES: Readonly<Record<string, string>> = {
	BCN: 'Europe/Madrid',
	TLL: 'Europe/Tallinn',
	VIE: 'Europe/Vienna',
	BGY: 'Europe/Rome',
	WAW: 'Europe/Warsaw',
	CRL: 'Europe/Brussels',
	STN: 'Europe/London'
};

/** The carrier `ryanair-mapper.ts` stamps on every offer it builds (`RYANAIR_CARRIER`), so
 * this is what a card sourced from Ryanair must show and nothing else. The flight NUMBERS in
 * the recorded fares come from the impossible `ZZ0000` pool instead (issue #156), which is
 * what makes a leaked fare recognisable on sight. */
export const RYANAIR_CARRIER_CODE = 'FR';

export function flies(from: string, to: string): boolean {
	return ROUTE_GRAPH[from]?.includes(to) ?? false;
}

/** The URL a person would land on, having filled the search form in and pressed go. */
export function resultsUrl(): string {
	const params = new URLSearchParams({
		dep: EARLIEST_DEPARTURE,
		arr: LATEST_ARRIVAL,
		from: ORIGIN,
		to: DESTINATION,
		people: '1'
	});
	return `/results/?${params.toString()}`;
}
