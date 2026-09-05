import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { OSRM_BASE_URL } from '../../../src/lib/providers/transfers/osrm';
import {
	AIRLINE_LOGO_BASE_URL,
	AIRLINE_LOGO_REDIRECT_HOST
} from '../../../src/lib/data/airline-logos';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './fixture-markers';

// Re-exported so a spec that wants to check "did this request really land on the host
// mockOsrm intercepts" (issue #132) can import it from here instead of reaching into
// src/lib itself.
export { AIRLINE_LOGO_BASE_URL, OSRM_BASE_URL };

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function loadFixture(relativePath: string): string {
	return readFileSync(path.join(fixturesDir, relativePath), 'utf-8');
}

/**
 * Anything that can register a route: a `BrowserContext`, or a single `Page`.
 *
 * Inside a spec both are safe, because Playwright closes the per-test context when the
 * test ends and takes every handler with it. Outside one they are not the same at all: a
 * context route survives the page, every navigation and every other tab, and a page route
 * survives the call that made it. That difference is why these helpers must never be run
 * against the shared Playwright MCP browser — see AGENTS.md, "Mocks belong to a test and
 * to nothing else", for the morning it cost.
 */
type Routable = BrowserContext | Page;

async function mockJson(target: Routable, urlPattern: string, fixture: string, status = 200) {
	const body = loadFixture(fixture);
	await target.route(urlPattern, async (route) => {
		await route.fulfill({ status, contentType: 'application/json', body });
	});
}

/**
 * Every provider host this app is known to call, and the mock that answers it in
 * tests. Keep this list in sync with `docs/prompts/002-setup-answers.md`'s CORS table
 * — that is the source of truth for which hosts the browser talks to directly.
 *
 * Each function is a no-key baseline mock (a realistic 200 with one or two results).
 * A test that needs a specific shape — no results, a rate-limit error, a slow response
 * — should call `context.route()` itself with a narrower pattern *after* calling these,
 * since Playwright gives the most-recently-registered matching route first refusal.
 */

/** One flight to hand back, in the shape a test wants to think about it.
 * `routeRyanairFlights` below splits each of these across the two endpoints the adapter
 * really reads. */
export interface RyanairFlightSpec {
	dep: string;
	arr: string;
	/** Wall-clock local at the departure airport, e.g. "2026-10-01T08:00:00". */
	depDate: string;
	/** Wall-clock local at the arrival airport. */
	arrDate: string;
	price: number;
	/** With the carrier prefix. Take it from `FIXTURE_FLIGHT_NUMBERS`: the timetable
	 * response below splits it into `carrierCode` + `number`, and the app joins the two
	 * back together, so a `ZZ00xx` here is what a leaked mock renders on the card and what
	 * `tools/probe-results.mjs` scans for. A realistic "FR1234" would make a mocked search
	 * indistinguishable from a working one. */
	flightNumber: string;
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Every airport the mocked active-airports list carries an IANA zone for, which is the set
 * of airports a mocked fare can actually become an offer at. Issue #354.
 *
 * Read from the fixture rather than typed out again, so adding an airport there is the
 * whole of adding it.
 */
function timeableAirports(): Set<string> {
	const airports = JSON.parse(loadFixture('ryanair/active-airports.json')) as {
		iataCode?: string;
		timeZone?: string;
	}[];
	return new Set(airports.filter((airport) => airport.timeZone).map((airport) => airport.iataCode!));
}

/**
 * Refuses to mock a fare at an airport the mocked airport list cannot put a clock on.
 *
 * Issue #354, and the afternoon it cost is the argument for it existing. Berlin was proposed
 * as a stopover on BCN -> TLL and then refused with "Nothing flies here", against a fixture
 * that priced BCN-BER exactly as it priced the four cities that worked. Request by request
 * the four BER got and the four Charleroi got were the same paths carrying the same bytes.
 * The response that differed was a fifth one nobody was looking at: `active-airports`, which
 * is where this adapter reads every airport's IANA zone, and BER was not in it.
 *
 * From there it is quiet the whole way down. `ryanair-mapper.ts` drops a fare whose origin or
 * destination has no zone, because issue #93 decided that a wrong UTC offset silently moves
 * an overnight connection by a night. `processCandidate` then sees zero outbound offers and
 * blocks the candidate as `no-outbound-flight`, whose sentence since issue #340 is "Nothing
 * flies here". Nothing logs, nothing fails, and the reason on screen is untrue.
 *
 * The fares fixture and the airport list are two halves of one answer and a spec only writes
 * the first, so the second is the half that gets forgotten. Throwing here names the airport
 * at the moment somebody adds the flight.
 */
function assertAirportsCanBeTimed(flights: readonly RyanairFlightSpec[]) {
	const timeable = timeableAirports();
	const missing = [...new Set(flights.flatMap((flight) => [flight.dep, flight.arr]))]
		.filter((iataCode) => !timeable.has(iataCode))
		.sort();
	if (missing.length === 0) return;
	throw new Error(
		`routeRyanairFlights was asked to price a flight at ${missing.join(', ')}, and ` +
			'tests/e2e/fixtures/ryanair/active-airports.json has no time zone for ' +
			`${missing.length > 1 ? 'those airports' : 'that airport'}. Every fare there is ` +
			'dropped by ryanair-mapper.ts and the city is then refused with "Nothing flies here", ' +
			'which is not true and is issue #354. Add it to that fixture with its IANA zone, or ' +
			'pass `{ airportsAnsweredBySpec: true }` if this spec answers the active-airports ' +
			'endpoint itself.'
	);
}

export interface RouteRyanairFlightsOptions {
	/** Set when the spec registers its own `active-airports` response, which brings its own
	 * zone table and makes the check above measure the wrong list.
	 * `itinerary-map-transfers.spec.ts` does exactly that, building a fictional three-airport
	 * network for a map it wants exact geometry from. */
	airportsAnsweredBySpec?: boolean;
}

/**
 * Answers both `services-api.ryanair.com` endpoints the adapter needs from one list of
 * flights (issue #137): `cheapestPerDay` for the prices and `timtbl/3/schedules` for the
 * flight numbers. Neither alone produces a single offer — the adapter drops any fare the
 * timetable does not confirm — so a test that mocks only one gets zero itineraries and no
 * clue why, which is exactly what this helper exists to prevent.
 *
 * It refuses outright to price a flight at an airport the mocked airport list cannot time,
 * for the same reason and after the same failure. See `assertAirportsCanBeTimed`.
 *
 * Days with no matching flight come back as `unavailable`, the way Ryanair itself answers
 * a day (or a whole route) it does not sell. Note that the fare calendar prices at most one
 * flight per day, so two flights on the same route and date cannot both be returned — give
 * them different dates.
 */
export async function routeRyanairFlights(
	target: Routable,
	flights: readonly RyanairFlightSpec[],
	options: RouteRyanairFlightsOptions = {}
) {
	if (!options.airportsAnsweredBySpec) assertAirportsCanBeTimed(flights);
	await target.route('https://services-api.ryanair.com/**', async (route) => {
		const url = new URL(route.request().url());

		const cheapestPerDay = /\/farfnd\/v4\/oneWayFares\/([A-Z]{3})\/([A-Z]{3})\/cheapestPerDay$/.exec(url.pathname);
		if (cheapestPerDay) {
			const [, dep, arr] = cheapestPerDay;
			const monthOfDate = url.searchParams.get('outboundMonthOfDate') ?? '';
			const year = Number(monthOfDate.slice(0, 4));
			const month = Number(monthOfDate.slice(5, 7));
			const fares = [];
			for (let day = 1; day <= daysInMonth(year, month); day++) {
				const isoDay = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
				const match = flights.find(
					(flight) => flight.dep === dep && flight.arr === arr && flight.depDate.startsWith(isoDay)
				);
				if (!match) {
					fares.push({ day: isoDay, departureDate: null, arrivalDate: null, price: null, soldOut: false, unavailable: true });
					continue;
				}
				const [whole, frac] = match.price.toFixed(2).split('.');
				fares.push({
					day: isoDay,
					departureDate: match.depDate,
					arrivalDate: match.arrDate,
					price: {
						value: match.price,
						valueMainUnit: whole,
						valueFractionalUnit: frac,
						currencyCode: 'EUR',
						currencySymbol: '€'
					},
					soldOut: false,
					unavailable: false
				});
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ outbound: { fares, minFare: null, maxFare: null } })
			});
			return;
		}

		const schedule = /\/timtbl\/3\/schedules\/([A-Z]{3})\/([A-Z]{3})\/years\/(\d{4})\/months\/(\d{1,2})$/.exec(
			url.pathname
		);
		if (schedule) {
			const [, dep, arr, year, month] = schedule;
			const prefix = `${year}-${String(Number(month)).padStart(2, '0')}-`;
			const days = flights
				.filter((flight) => flight.dep === dep && flight.arr === arr && flight.depDate.startsWith(prefix))
				.map((flight) => ({
					day: Number(flight.depDate.slice(8, 10)),
					flights: [
						{
							carrierCode: flight.flightNumber.slice(0, 2),
							number: flight.flightNumber.slice(2),
							departureTime: flight.depDate.slice(11, 16),
							arrivalTime: flight.arrDate.slice(11, 16)
						}
					]
				}));
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ month: Number(month), days })
			});
			return;
		}

		await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
	});
}

/** A generic STN -> VIE pair, for a test that only needs Ryanair to answer something.
 * Impossible flight numbers and absurd fares on purpose — see support/fixture-markers.ts. */
const DEFAULT_RYANAIR_FLIGHTS: readonly RyanairFlightSpec[] = [
	{
		dep: 'STN',
		arr: 'VIE',
		depDate: '2027-03-08T06:35:00',
		arrDate: '2027-03-08T09:50:00',
		price: FIXTURE_PRICES.first,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[0]
	},
	{
		dep: 'STN',
		arr: 'VIE',
		depDate: '2027-03-09T17:20:00',
		arrDate: '2027-03-09T20:35:00',
		price: FIXTURE_PRICES.second,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[1]
	}
];

/** Ryanair's public fare source. Needs no key — this is the "still useful with zero
 * keys configured" baseline the brief and issue #18 both call out. A test that needs its
 * own route should call `routeRyanairFlights` with its own flights AFTER this, since
 * Playwright gives the most-recently-registered matching route first refusal. */
export async function mockRyanair(target: Routable, flights: readonly RyanairFlightSpec[] = DEFAULT_RYANAIR_FLIGHTS) {
	await routeRyanairFlights(target, flights);
}

/**
 * Ryanair's active-airports list, which since issue #121 answers both non-fare questions
 * the adapter has: every airport's IANA timezone (the fare-finder response carries none,
 * so without this every offer is silently dropped for "unknown timezone") and every
 * airport's `routes` array, which is issue #12's connection graph — "which airports does
 * this one fly to", for the whole network in one response.
 *
 * There used to be a second mock next to this one for
 * `/views/locate/searchWidget/routes/en/airport/**`, answering the same fixture for every
 * airport code asked. That endpoint is gone from the adapter, so a test that mocks it now
 * mocks nothing: the search gets no route graph, finds no candidate, and fails on a
 * missing result card rather than on anything to do with what it was testing. If a route
 * graph is what your test needs, put `routes` on the airports in the fixture.
 */
export async function mockRyanairActiveAirports(target: Routable, fixture = 'ryanair/active-airports.json') {
	await mockJson(target, 'https://www.ryanair.com/api/views/locate/3/airports/en/active', fixture);
}

/** Skyscanner, reached through RapidAPI's "sky-scrapper" product. Requires the user's
 * own RapidAPI key — never call the real host in a test, see tests/e2e/README.md. */
export async function mockSkyscanner(target: Routable, fixture = 'skyscanner/search-flights.json') {
	await mockJson(target, 'https://sky-scrapper.p.rapidapi.com/**', fixture);
}

/** Rome2Rio transfers (walking/transit/driving between an airport and a hotel), via
 * RapidAPI. Requires the user's own key. */
export async function mockRome2Rio(target: Routable, fixture = 'rome2rio/search.json') {
	await mockJson(target, 'https://rome2rio.p.rapidapi.com/**', fixture);
}

/** Booking.com hotel search, via RapidAPI's "booking-com15" product. Requires the
 * user's own key. */
export async function mockBookingCom(target: Routable, fixture = 'booking/hotels-search.json') {
	await mockJson(target, 'https://booking-com15.p.rapidapi.com/**', fixture);
}

/**
 * Kiwi.com's public GraphQL endpoint, the second keyless flight source. Needs no key.
 *
 * Its queries hit the same URL and are told apart by `?featureName=`, so this registers a
 * route each rather than one. Issue #340 added a third, `DirectRouteCheckQuery`, which asks
 * whether one airport flies to another; it reuses the one-way document, so it is answered
 * with the one-way fixture. Leaving it unregistered is not neutral: the network guard blocks
 * it, Chromium reports `ERR_BLOCKED_BY_CLIENT`, and every spec that asserts a clean console
 * fails for a reason that has nothing to do with what it tests. All fixtures are
 * deliberately EMPTY: every
 * existing spec asserts against Ryanair-shaped results, and answering with real Kiwi
 * itineraries would change their itinerary counts for reasons that have nothing to do with
 * what they are testing. An empty-but-well-formed response is the honest "this provider
 * answered and had nothing to add", which is a real thing Kiwi does (a nonexistent airport
 * code returns exactly this shape). A spec that wants Kiwi to contribute results should
 * register its own narrower route afterwards.
 */
export async function mockKiwiPublic(
	target: Routable,
	oneWayFixture = 'kiwi-public/one-way-empty.json',
	onePerCityFixture = 'kiwi-public/one-per-city-empty.json'
) {
	await mockJson(
		target,
		'https://api.skypicker.com/umbrella/v2/graphql?featureName=SearchOneWayItinerariesQuery*',
		oneWayFixture
	);
	await mockJson(
		target,
		'https://api.skypicker.com/umbrella/v2/graphql?featureName=OnePerCityItinerariesQuery*',
		onePerCityFixture
	);
	await mockJson(
		target,
		'https://api.skypicker.com/umbrella/v2/graphql?featureName=DirectRouteCheckQuery*',
		oneWayFixture
	);
}

/**
 * Hostelworld's own backend, the keyless bed source. Needs no key.
 *
 * Two routes, because the adapter cannot price anything until it has resolved a city id:
 * `/continents/{1..6}/countries/` builds that index and `/cities/{id}/properties/` prices
 * it. Registering only the second leaves the first blocked by the network guard, which
 * fails every results spec on an unmocked host rather than on anything they test.
 *
 * Both defaults are deliberately EMPTY, the same call `mockKiwiPublic` above makes and for
 * the same reason: every existing spec asserts against Ryanair-shaped results with no bed
 * priced, and answering with real hostels would change their totals for reasons unrelated
 * to what they check. An empty country list is a real shape — it is what a continent the
 * adapter has no inventory in looks like. A spec that wants a bed priced passes the real
 * captured fixtures instead, as `keyless-bed.spec.ts` does.
 */
export async function mockHostelworld(
	target: Routable,
	continentsFixture = 'hostelworld/continents-empty.json',
	propertiesFixture = 'hostelworld/properties-empty.json'
) {
	await mockJson(target, 'https://api.m.hostelworld.com/2.2/continents/**', continentsFixture);
	await mockJson(target, 'https://api.m.hostelworld.com/2.2/cities/**', propertiesFixture);
}

/** Transitous/MOTIS public transport timetables. Needs no key. */
export async function mockTransitous(target: Routable, fixture = 'transitous/plan.json') {
	await mockJson(target, 'https://api.transitous.org/**', fixture);
}

/** OSRM walking/driving times and routes. Needs no key. Intercepts `OSRM_BASE_URL`,
 * imported straight from the adapter (issue #132) rather than a copy of the host kept
 * here, so this can't silently drift from whatever host `osrm.ts` actually calls again
 * the way it already did once — the adapter moved off `router.project-osrm.org` to
 * `routing.openstreetmap.de`, and this mock kept intercepting the old host for months
 * because nothing exercised it. */
export async function mockOsrm(target: Routable, fixture = 'osrm/route.json') {
	await mockJson(target, `${OSRM_BASE_URL}/**`, fixture);
}

/** Registers every keyless provider (Ryanair — the fare-finder and active-airports, both
 * real endpoints the adapter calls — Kiwi's public endpoint, Hostelworld, Transitous,
 * OSRM). This is the state a first-time visitor with an empty key store is in — see issue
 * #18's "first run with no keys" scenario and issue #3 (the key store). */
export async function mockAllKeylessProviders(target: Routable) {
	await mockRyanair(target);
	await mockRyanairActiveAirports(target);
	await mockKiwiPublic(target);
	await mockHostelworld(target);
	await mockTransitous(target);
	await mockOsrm(target);
}

/** Registers every provider, keyed and keyless alike, each with its default fixture. */
export async function mockAllProviders(target: Routable) {
	await mockAllKeylessProviders(target);
	await mockSkyscanner(target);
	await mockRome2Rio(target);
	await mockBookingCom(target);
}

/**
 * Airline logo images. Not a provider a spec opts into: `AirlineLogo.svelte` fires this
 * request on any page that renders a flight, so `fixtures.ts` wires it globally rather
 * than leaving each spec to remember. Without it the network guard blocks the request and
 * every results spec fails on an unmocked host.
 *
 * Both hosts are mocked from the constants the component itself uses (issue #132's rule:
 * a test host derived from the real one cannot drift from it). The second exists because
 * a code the CDN has never heard of redirects through `fe-resize-image.skypicker.com` on
 * its way to the generic glyph, and a redirect target is a separate host as far as the
 * guard is concerned.
 *
 * A one-pixel transparent PNG is enough: nothing asserts on the pixels, only on the
 * request being made and on the monogram fallback firing when it is not.
 */
const TRANSPARENT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);

export async function mockAirlineLogos(target: Routable) {
	for (const host of [AIRLINE_LOGO_BASE_URL, AIRLINE_LOGO_REDIRECT_HOST]) {
		await target.route(`${new URL(host).origin}/**`, async (route) => {
			await route.fulfill({ status: 200, contentType: 'image/png', body: TRANSPARENT_PNG });
		});
	}
}
