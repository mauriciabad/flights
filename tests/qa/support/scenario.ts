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

/**
 * The days inside the window on which the bench actually has a seat to sell.
 *
 * Three rather than one, and spaced two days apart, because issue #137 is precisely that
 * one date pair per stopover leaves the traveller unable to choose how many nights the
 * stopover lasts (docs/ACCEPTANCE.md condition 4). Spacing them also means the two legs of
 * an itinerary can never be the same day, which is what a multi-day stopover is.
 *
 * Every other day of the month comes back `unavailable: true`, which is how Ryanair's own
 * fare calendar answers a day it does not sell — and, per ryanair-types.ts, how it answers
 * a route it does not fly at all.
 */
export const SELLING_DAY_OFFSETS: readonly number[] = [0, 2, 4];

/** Wall-clock departure and arrival at their own airports, one pair per selling day. Local
 * times, not instants: `ryanair-timezone.ts` places each end in its own zone, and every
 * pair here stays positive across the scenario's zones (Madrid +2 through Tallinn +3). */
export const SELLING_DAY_TIMES: readonly { departure: string; arrival: string }[] = [
	{ departure: '07:05', arrival: '09:55' },
	{ departure: '13:40', arrival: '16:30' },
	{ departure: '18:15', arrival: '21:05' }
];

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

/**
 * Every route question a cold search sends Kiwi, as `FROM->TO`, with `BCN->*` for the "where
 * does this airport fly at all" query that starts the search.
 *
 * Issue #379: the universe a check ranks against has to be written down, or the check passes
 * for a reason nobody stated. Before `bench.ts` answered the bundled route datasets, this
 * same search asked about `BTS`, `CGN`, `EIN`, `HAJ`, `HHN`, `NUE`, `OSR` and `RTM` — eight
 * airports this file has never named, every one of them out of Ryanair's real shipped
 * snapshot. The count was nine then and it is nine now, which is why counting was never
 * going to catch it.
 *
 * Where each entry comes from:
 *
 * - `BCN->*` starts every search.
 * - `STN->TLL` is in `ROUTE_GRAPH` as an origin-side candidate, and the graph does not say
 *   Stansted flies on to Tallinn, so the search pays a request to ask. `VIE`, `BGY`, `WAW`
 *   and `CRL` are confirmed onward for free and cost nothing.
 * - The other seven are Barcelona's edges in `algorithm/connections-fallback-data.ts`, a
 *   hand table compiled into the app bundle rather than fetched. The bench cannot answer for
 *   it, so it is named here instead. None of the seven survives — nothing confirms an onward
 *   leg to Tallinn — but each costs the request that proves it.
 *
 * When this list moves, find the source it moved from before editing it.
 */
export const ROUTE_QUESTIONS_ASKED: readonly string[] = [
	'BCN->*',
	'BUD->TLL',
	'CIA->TLL',
	'DUB->TLL',
	'FCO->TLL',
	'KRK->TLL',
	'LTN->TLL',
	'MXP->TLL',
	'STN->TLL'
];
