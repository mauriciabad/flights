/**
 * What the recorded providers answer.
 *
 * Two rules shape everything here.
 *
 * **Answer like the provider, not like the test.** Ryanair returns fares for the leg it was
 * asked about and an empty list for one it does not fly. Agoda quotes in the currency it was
 * asked for and in USD when it was asked for nothing, which is the behaviour
 * `agoda-mapper.ts` documents from a live call on 2026-09-04. A bench that always says yes
 * cannot catch a caller that forgot to ask.
 *
 * **Mark everything, using the scheme that already exists.** Issue #156 made a fixture
 * worthless as an answer: names carry `FIXTURE`, flight numbers come from an impossible
 * `ZZ0000` pool, prices sit in a five-figure band no fare or hostel bed lands in. These
 * responses draw from the same manifest, so `tools/probe-results.mjs` and
 * `tests/e2e/guard.spec.ts` recognise a leak from here exactly as they would from any other
 * mock, and `no-fixture-data.qa.ts` does not need a second scheme to check.
 *
 * Response shapes come from the repo's existing fixtures wherever the shape does not need to
 * vary, so this file never becomes a second, drifting copy of what a provider sends. Only
 * Ryanair's three endpoints are synthesised, because only those have to answer differently
 * per route.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	AIRPORT_TIME_ZONES,
	EARLIEST_DEPARTURE,
	LATEST_ARRIVAL,
	ROUTE_GRAPH,
	SELLING_DAY_OFFSETS,
	SELLING_DAY_TIMES,
	flies
} from './scenario';
import { FIXTURE_TEXT_TOKEN } from './markers';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from '../../e2e/support/fixture-markers';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

function readJson(relativePath: string): unknown {
	return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf-8'));
}

/** Keys whose string values a screen is likely to show a person. Stamping the marker into
 * these and nothing else keeps codes, dates and ids parseable while making anything the app
 * displays traceable back to a provider answer. */
const HUMAN_READABLE_KEYS = new Set([
	'name',
	'displayName',
	'accessibilityLabel',
	'hotel_name',
	'title',
	'label',
	'city',
	'seoName'
]);

/** Walks a decoded body and marks every human-readable string, in place on a fresh copy.
 * Recursive rather than a regex over the raw text so a code or a date that happens to look
 * like a name is never touched. */
function stamp<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => stamp(item)) as unknown as T;
	if (value === null || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === 'string' && HUMAN_READABLE_KEYS.has(key) && !item.includes(FIXTURE_TEXT_TOKEN)) {
			out[key] = `${FIXTURE_TEXT_TOKEN} ${item}`;
		} else {
			out[key] = stamp(item);
		}
	}
	return out as unknown as T;
}

/** Rewrites every ISO currency code in a decoded body. Models a provider quoting the whole
 * answer in one currency, which is what both stay providers actually do — neither ever
 * mixes two within a single response. */
function inCurrency<T>(value: T, currency: string): T {
	const text = JSON.stringify(value).replace(/"(EUR|USD|GBP)"/g, `"${currency}"`);
	return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Ryanair (keyless): three endpoints, all route-aware.
//
// The two fare endpoints are the pair issue #137 introduced. Neither alone produces a
// single offer, because `ryanair-mapper.ts` drops any fare the timetable does not confirm,
// so they are derived from one `benchFlight` below rather than written out twice.
//
// Neither carries a human-readable string to stamp `FIXTURE` into. Their marking is the
// impossible carrier code and the five-figure fare band, which the app joins back together
// on screen as "ZZ0000" at "€9,111.11" — what `tools/probe-results.mjs` scans the page for.
// ---------------------------------------------------------------------------

/**
 * `/api/views/locate/3/airports/en/active`. Since issue #121 this one response answers both
 * "what timezone is this airport in" and "where does it fly", so the whole route graph lives
 * here rather than in a per-airport call.
 */
export function ryanairActiveAirports(): unknown {
	return Object.entries(AIRPORT_TIME_ZONES).map(([iataCode, timeZone]) => ({
		iataCode,
		name: `${FIXTURE_TEXT_TOKEN} ${iataCode} record`,
		timeZone,
		routes: (ROUTE_GRAPH[iataCode] ?? []).map((code) => `airport:${code}`)
	}));
}

/**
 * One flight the bench is willing to sell, or `undefined` for a route-and-day it has
 * nothing on.
 *
 * Both fare endpoints below are derived from this single function, which is the whole
 * point of it. Issue #137 split Ryanair's answer across two requests — `cheapestPerDay`
 * has the price and no flight identity, `timtbl/3/schedules` has the identity and no
 * price — and `ryanair-mapper.ts` joins them on the exact departure minute, dropping any
 * fare the timetable does not confirm. A bench whose two endpoints disagreed by a minute
 * would return zero offers and give no hint why.
 */
interface BenchFlight {
	/** From the impossible pool, split the way the timetable splits it: `ZZ0000` becomes
	 * carrier `ZZ` and number `0000`, which `ryanair-mapper.ts` joins back into `ZZ0000` on
	 * the card. A leaked fare therefore still reads as nonsense on sight (issue #156). */
	carrierCode: string;
	number: string;
	departureTime: string;
	arrivalTime: string;
	/** Major units, five figures, from the shared pool. */
	price: number;
}

const SELLING_PRICES = [FIXTURE_PRICES.first, FIXTURE_PRICES.second, FIXTURE_PRICES.third];

/** Which of the scenario's selling days `isoDay` is, or -1 for any other day. */
function sellingDayIndex(isoDay: string): number {
	const start = Date.parse(`${EARLIEST_DEPARTURE}T00:00:00Z`);
	const latest = Date.parse(`${LATEST_ARRIVAL}T00:00:00Z`);
	return SELLING_DAY_OFFSETS.findIndex((offset) => {
		const day = start + offset * 24 * 60 * 60 * 1000;
		return day <= latest && new Date(day).toISOString().slice(0, 10) === isoDay;
	});
}

function benchFlight(from: string, to: string, isoDay: string): BenchFlight | undefined {
	// The route graph is the ground truth `no-fabricated-flights.qa.ts` holds the app to, so
	// this is the one place that decides what was ever offered. A pair outside it gets the
	// same answer the real endpoint gives for a route Ryanair does not fly: a month of
	// `unavailable` rows and an empty timetable (ryanair-types.ts, measured 2026-09-04).
	if (!flies(from, to)) return undefined;
	if (AIRPORT_TIME_ZONES[from] === undefined || AIRPORT_TIME_ZONES[to] === undefined) return undefined;

	const index = sellingDayIndex(isoDay);
	if (index === -1) return undefined;

	const flightNumber = fixtureFlightNumber(from, to, index);
	const times = SELLING_DAY_TIMES[index];
	return {
		carrierCode: flightNumber.slice(0, 2),
		number: flightNumber.slice(2),
		departureTime: times.departure,
		arrivalTime: times.arrival,
		price: SELLING_PRICES[index]
	};
}

/**
 * `/farfnd/v4/oneWayFares/{origin}/{destination}/cheapestPerDay` — the cheapest sellable
 * fare per calendar day, for the whole month `outboundMonthOfDate` falls in.
 *
 * The airports are in the path, not in the response: this endpoint echoes back neither, so
 * `ryanair-mapper.ts` takes them from the request it made. Anything reading "which legs did
 * the provider offer" back out of a recording has to do the same (see
 * `no-fabricated-flights.qa.ts`).
 *
 * Prices are in the currency the caller asked for, defaulting to EUR, because the real
 * endpoint takes a `currency` parameter and honours it.
 */
export function ryanairCheapestPerDay(url: URL): unknown {
	const route = fareRouteFromPath(url.pathname);
	const monthOfDate = url.searchParams.get('outboundMonthOfDate') ?? EARLIEST_DEPARTURE;
	const currency = url.searchParams.get('currency') ?? 'EUR';
	const year = Number(monthOfDate.slice(0, 4));
	const month = Number(monthOfDate.slice(5, 7));
	if (!route || !Number.isInteger(year) || !Number.isInteger(month)) {
		return { outbound: { fares: [], minFare: null, maxFare: null } };
	}

	const fares: unknown[] = [];
	for (let day = 1; day <= daysInMonth(year, month); day += 1) {
		const isoDay = `${year}-${pad(month)}-${pad(day)}`;
		const flight = benchFlight(route.origin, route.destination, isoDay);
		if (!flight) {
			fares.push({ day: isoDay, departureDate: null, arrivalDate: null, price: null, soldOut: false, unavailable: true });
			continue;
		}
		const [whole, fractional] = flight.price.toFixed(2).split('.');
		fares.push({
			day: isoDay,
			departureDate: `${isoDay}T${flight.departureTime}:00`,
			arrivalDate: `${isoDay}T${flight.arrivalTime}:00`,
			price: {
				value: flight.price,
				valueMainUnit: whole,
				valueFractionalUnit: fractional,
				currencySymbol: currency === 'EUR' ? '€' : '$',
				currencyCode: currency
			},
			soldOut: false,
			unavailable: false
		});
	}

	return { outbound: { fares, minFare: null, maxFare: null } };
}

/**
 * `/timtbl/3/schedules/{origin}/{destination}/years/{year}/months/{month}` — every flight
 * timetabled on the route that month, with the carrier code and number the fare calendar
 * omits. Only days that have a flight appear at all, and a route Ryanair does not fly
 * answers `200 {"month":10,"days":[]}` rather than a 404.
 */
export function ryanairMonthlySchedule(url: URL): unknown {
	const parts = schedulePathParts(url.pathname);
	if (!parts) return { month: 0, days: [] };
	const { origin, destination, year, month } = parts;

	const days: unknown[] = [];
	for (let day = 1; day <= daysInMonth(year, month); day += 1) {
		const flight = benchFlight(origin, destination, `${year}-${pad(month)}-${pad(day)}`);
		if (!flight) continue;
		days.push({
			day,
			flights: [
				{
					carrierCode: flight.carrierCode,
					number: flight.number,
					departureTime: flight.departureTime,
					arrivalTime: flight.arrivalTime
				}
			]
		});
	}

	return { month, days };
}

/** `/farfnd/v4/oneWayFares/BCN/VIE/cheapestPerDay` -> `{ origin: 'BCN', destination: 'VIE' }`. */
function fareRouteFromPath(pathname: string): { origin: string; destination: string } | undefined {
	const match = /\/farfnd\/v4\/oneWayFares\/([A-Z]{3})\/([A-Z]{3})\/cheapestPerDay$/.exec(pathname);
	return match ? { origin: match[1], destination: match[2] } : undefined;
}

/** `/timtbl/3/schedules/BCN/VIE/years/2026/months/10` -> the four values in it. */
function schedulePathParts(
	pathname: string
): { origin: string; destination: string; year: number; month: number } | undefined {
	const match = /\/timtbl\/3\/schedules\/([A-Z]{3})\/([A-Z]{3})\/years\/(\d{4})\/months\/(\d{1,2})$/.exec(pathname);
	return match
		? { origin: match[1], destination: match[2], year: Number(match[3]), month: Number(match[4]) }
		: undefined;
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/** An impossible flight number from the shared pool, picked deterministically per leg so a
 * given route always reports the same one and a failure message is reproducible. */
function fixtureFlightNumber(from: string, to: string, index: number): string {
	let hash = index;
	for (const char of `${from}${to}`) hash = (hash * 31 + char.charCodeAt(0)) % FIXTURE_FLIGHT_NUMBERS.length;
	return FIXTURE_FLIGHT_NUMBERS[hash];
}

// ---------------------------------------------------------------------------
// Stays. Both providers quote in the currency they were asked for.
// ---------------------------------------------------------------------------

const agodaSearchBody = readJson('src/lib/providers/stays/fixtures/agoda-search-vienna.json');
const agodaPricesBody = readJson('src/lib/providers/stays/fixtures/agoda-get-prices-wombats-hostel.json');
const bookingSearchBody = readJson('tests/e2e/fixtures/booking/hotels-search.json');
const bookingRoomsBody = readJson('src/lib/providers/stays/fixtures/booking-room-list-ibis.json');
const nominatimBody = readJson('src/lib/providers/stays/fixtures/nominatim-vienna.json');
const osrmBody = readJson('tests/e2e/fixtures/osrm/route.json');
const transitousBody = readJson('tests/e2e/fixtures/transitous/plan.json');

/**
 * Coordinates for every airport the scenario can name, read from the app's own OurAirports
 * dataset rather than typed out here — the stay adapters filter what they get back by
 * distance, so a bench that answered with the same city's hotels no matter where it was
 * asked would have every property rejected as too far and would look exactly like a
 * provider that found nothing.
 */
const airportCoordinates = new Map<string, { latitude: number; longitude: number }>(
	(readJson('src/lib/data/airports.generated.json') as { iataCode: string; latitude: number; longitude: number }[])
		.filter((row) => AIRPORT_TIME_ZONES[row.iataCode] !== undefined)
		.map((row) => [row.iataCode, { latitude: row.latitude, longitude: row.longitude }])
);

/** Moves every property in a decoded stay body to sit beside `near`, keeping their relative
 * spread so a distance-based ranking still has something to rank. */
function relocate<T>(value: T, near: { latitude: number; longitude: number } | undefined): T {
	if (near === undefined) return value;
	const text = JSON.stringify(value)
		.replace(/"latitude"\s*:\s*-?[\d.]+/g, `"latitude":${near.latitude}`)
		.replace(/"longitude"\s*:\s*-?[\d.]+/g, `"longitude":${near.longitude}`);
	return JSON.parse(text) as T;
}

/**
 * Agoda searches by place NAME, so the bench has to work out which of the scenario's
 * airports that name refers to. `geocode/airport-city.ts` builds the name from the app's own
 * dataset ("Orio al Serio, Italy"), so matching the airport's own city back out of it is the
 * same lookup in reverse.
 */
function airportForLocationName(name: string): string | undefined {
	const rows = readJson('src/lib/data/airports.generated.json') as { iataCode: string; city: string }[];
	for (const code of Object.keys(AIRPORT_TIME_ZONES)) {
		const city = rows.find((row) => row.iataCode === code)?.city;
		if (city && name.toLowerCase().includes(city.toLowerCase())) return code;
	}
	return undefined;
}

export function agodaSearch(url: URL): unknown {
	const code = airportForLocationName(url.searchParams.get('location') ?? '');
	return stamp(relocate(agodaSearchBody, code ? airportCoordinates.get(code) : undefined));
}

/**
 * `currency_id` present means the caller named a currency and gets it. Absent means Agoda's
 * own default, USD — `agoda-mapper.ts`: "USD has no id: it never appears in Agoda's own
 * `/currencies` list (captured 2026-09-04) and is instead the implicit default when
 * `currency_id` is omitted entirely."
 *
 * This one branch is what makes the currency invariant testable at all. A bench that always
 * answered EUR would let a pipeline that never asks for a currency look perfectly healthy.
 */
export function agodaGetPrices(url: URL): unknown {
	const currency = url.searchParams.get('currency_id') ? 'EUR' : 'USD';
	return stamp(inCurrency(agodaPricesBody, currency));
}

export function bookingSearch(url: URL): unknown {
	const latitude = Number(url.searchParams.get('latitude'));
	const longitude = Number(url.searchParams.get('longitude'));
	const near = Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : undefined;
	return stamp(relocate(inCurrency(bookingSearchBody, url.searchParams.get('currency_code') ?? 'USD'), near));
}

export function bookingRooms(url: URL): unknown {
	return stamp(inCurrency(bookingRoomsBody, url.searchParams.get('currency_code') ?? 'USD'));
}

export function nominatimReverse(): unknown {
	return stamp(nominatimBody);
}

// ---------------------------------------------------------------------------
// Hostelworld (keyless): two endpoints, and the first one exists only to make the second
// answerable.
//
// `/cities/{id}/properties/` is keyed by a city id, while the app only ever knows a
// coordinate. The adapter bridges that with `/continents/{id}/countries/`, so the bench has
// to answer both or the price call is never made at all — the failure would read as
// "Hostelworld found no beds" rather than as a missing recording.
// ---------------------------------------------------------------------------

const hostelworldPropertiesBody = readJson('src/lib/providers/stays/fixtures/hostelworld-properties-london.json');

/** Hostelworld's own id for Europe (`hostelworld-client.ts`). Every airport the scenario
 * names is European, so this is the only continent that carries cities. */
const HOSTELWORLD_EUROPE_ID = 3;

/**
 * A bench city id per scenario airport, and the way back.
 *
 * Offset into a band no real Hostelworld id occupies (its London is 3, its largest here is
 * five digits) so a leaked id is recognisable rather than plausible, and derived from the
 * airport order so the properties handler can turn one back into the coordinate it must
 * answer beside.
 */
const HOSTELWORLD_BENCH_CITY_ID_BASE = 990_000;
const benchCityAirports: readonly string[] = Object.keys(AIRPORT_TIME_ZONES);

function benchCityIdFor(index: number): number {
	return HOSTELWORLD_BENCH_CITY_ID_BASE + index;
}

function airportForBenchCityId(cityId: number): string | undefined {
	return benchCityAirports[cityId - HOSTELWORLD_BENCH_CITY_ID_BASE];
}

/**
 * `/2.2/continents/{id}/countries/`: every country with its city list and real coordinates.
 *
 * The cities are the scenario's own airports, at their own coordinates. Answering with
 * Hostelworld's real geography instead would put every scenario airport hundreds of
 * kilometres from the nearest listed city, `mapPropertiesToStays` would correctly reject
 * every property as out of radius, and the result on screen would be indistinguishable from
 * a broken adapter — the same trap `relocate` exists to avoid for Agoda and Booking.
 *
 * The five non-European continents answer with an empty country list. That is a real shape:
 * the adapter flattens all six and filters by distance, so a continent with nothing in it
 * contributes nothing either way.
 */
export function hostelworldContinent(url: URL): unknown {
	const continentId = Number(/\/continents\/(\d+)\/countries\//.exec(url.pathname)?.[1]);
	if (continentId !== HOSTELWORLD_EUROPE_ID) return { countries: [] };
	return stamp({
		countries: [
			{
				id: 237,
				name: 'Benchland',
				cities: benchCityAirports.map((code, index) => ({
					id: benchCityIdFor(index),
					name: code,
					latitude: airportCoordinates.get(code)?.latitude ?? 0,
					longitude: airportCoordinates.get(code)?.longitude ?? 0
				}))
			}
		]
	});
}

/**
 * `/2.2/cities/{id}/properties/`: priced properties for one city.
 *
 * Quotes in the currency it was asked for, and in EUR when asked for nothing — measured
 * 2026-09-04 against the real host, where omitting `currency` returned `200` with every
 * price in EUR. Same reason Agoda's handler branches on `currency_id`: a bench that always
 * answered in the search's currency could not catch a pipeline that never asked for one.
 */
export function hostelworldProperties(url: URL): unknown {
	const cityId = Number(/\/cities\/(\d+)\/properties\//.exec(url.pathname)?.[1]);
	const code = airportForBenchCityId(cityId);
	const currency = url.searchParams.get('currency') ?? 'EUR';
	return stamp(
		relocate(inCurrency(hostelworldPropertiesBody, currency), code ? airportCoordinates.get(code) : undefined)
	);
}

/**
 * Kiwi's keyless GraphQL endpoint (issue #157). Answered as a valid, empty result rather
 * than with invented itineraries: "this aggregator found nothing for this route" is a real
 * provider answer, it keeps the scenario's offers coming from one source so
 * `no-fabricated-flights.qa.ts` can attribute every leg, and it still exercises the request
 * that `cost-per-search.qa.ts` counts. A recorded Kiwi that offered fares would be worth
 * adding the day an invariant needs two flight providers disagreeing.
 */
export function kiwiPublicGraphQl(url: URL): unknown {
	const feature = url.searchParams.get('featureName') ?? '';
	const key = feature.startsWith('OnePerCity') ? 'onewayOnePerCityItineraries' : 'onewayItineraries';
	return { data: { [key]: { __typename: 'Itineraries', itineraries: [] } } };
}

export function osrmRoute(): unknown {
	return osrmBody;
}

export function transitousPlan(): unknown {
	return transitousBody;
}
