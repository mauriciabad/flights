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
import { AIRPORT_TIME_ZONES, ROUTE_GRAPH, RYANAIR_CARRIER_CODE, flies } from './scenario';
import { FIXTURE_TEXT_TOKEN } from './markers';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_NAMES, FIXTURE_PRICES } from '../../e2e/support/fixture-markers';

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

/** `/searchWidget/routes/en/airport/{code}` — who this airport flies to. Returns `[]` for an
 * airport outside the scenario rather than a 404, so a missing entry reads as "no routes"
 * and never as a network failure the app would report differently. */
export function ryanairRoutes(airportCode: string): unknown {
	return (ROUTE_GRAPH[airportCode] ?? []).map((code) => ({
		arrivalAirport: { code },
		recent: false,
		seasonal: false,
		operator: RYANAIR_CARRIER_CODE,
		tags: []
	}));
}

function airportBlock(code: string) {
	return {
		countryName: FIXTURE_NAMES.country,
		iataCode: code,
		name: `${FIXTURE_TEXT_TOKEN} ${code} airport`,
		seoName: code.toLowerCase()
	};
}

/**
 * `/farfnd/v4/oneWayFares`. Two fares per leg, on the first and (where the window allows)
 * the third day of the requested range, so `FlightPicker` has something to pick between —
 * a single forced date pair is issue #137, and a bench that only ever offers one would make
 * that defect invisible here too.
 *
 * Prices are in the currency the caller asked for, defaulting to EUR: Ryanair's fare finder
 * takes a `currency` parameter and honours it.
 */
export function ryanairOneWayFares(url: URL): unknown {
	const from = url.searchParams.get('departureAirportIataCode') ?? '';
	const to = url.searchParams.get('arrivalAirportIataCode');
	const dateFrom = url.searchParams.get('outboundDepartureDateFrom') ?? '2026-10-06';
	const dateTo = url.searchParams.get('outboundDepartureDateTo') ?? dateFrom;
	const currency = url.searchParams.get('currency') ?? 'EUR';

	const destinations = to ? [to] : (ROUTE_GRAPH[from] ?? []);
	const fares: unknown[] = [];

	for (const destination of destinations) {
		if (!flies(from, destination)) continue;
		if (AIRPORT_TIME_ZONES[from] === undefined || AIRPORT_TIME_ZONES[destination] === undefined) continue;
		for (const [index, date] of departureDates(dateFrom, dateTo).entries()) {
			fares.push({
				outbound: {
					departureAirport: airportBlock(from),
					arrivalAirport: airportBlock(destination),
					departureDate: `${date}T07:${index === 0 ? '05' : '40'}:00`,
					arrivalDate: `${date}T09:${index === 0 ? '55' : '30'}:00`,
					// Five figures, from the shared pool: a leaked fare has to read as nonsense at
					// a glance rather than as a bargain somebody might act on (issue #156).
					price: {
						value: index === 0 ? FIXTURE_PRICES.first : FIXTURE_PRICES.second,
						valueMainUnit: String(Math.trunc(index === 0 ? FIXTURE_PRICES.first : FIXTURE_PRICES.second)),
						valueFractionalUnit: index === 0 ? '11' : '22',
						currencySymbol: currency === 'EUR' ? '€' : '$',
						currencyCode: currency
					},
					flightNumber: fixtureFlightNumber(from, destination, index),
					flightKey: `ZZ~${fixtureFlightNumber(from, destination, index)}~~${from}~${destination}~${date}~${date}~1`,
					previousPrice: null
				}
			});
		}
	}

	return { fares, size: fares.length, currency };
}

/** An impossible flight number from the shared pool, picked deterministically per leg so a
 * given route always reports the same one and a failure message is reproducible. */
function fixtureFlightNumber(from: string, to: string, index: number): string {
	let hash = index;
	for (const char of `${from}${to}`) hash = (hash * 31 + char.charCodeAt(0)) % FIXTURE_FLIGHT_NUMBERS.length;
	return FIXTURE_FLIGHT_NUMBERS[hash];
}

/** At most two dates in the requested window: its first day, and two days later when that
 * still falls inside it. */
function departureDates(from: string, to: string): string[] {
	const start = new Date(`${from}T00:00:00Z`);
	const end = new Date(`${to}T00:00:00Z`);
	const dates = [from];
	const second = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);
	if (second <= end) dates.push(second.toISOString().slice(0, 10));
	return dates;
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
