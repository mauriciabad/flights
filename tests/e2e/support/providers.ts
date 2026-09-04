import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { OSRM_BASE_URL } from '../../../src/lib/providers/transfers/osrm';
import { AIRLINE_LOGO_BASE_URL } from '../../../src/lib/data/airline-logos';

// Re-exported so a spec that wants to check "did this request really land on the host
// mockOsrm/mockAirlineLogos intercepts" (issues #132, #119) can import it from here
// instead of reaching into src/lib itself.
export { OSRM_BASE_URL, AIRLINE_LOGO_BASE_URL };

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function loadFixture(relativePath: string): string {
	return readFileSync(path.join(fixturesDir, relativePath), 'utf-8');
}

function loadBinaryFixture(relativePath: string): Buffer {
	return readFileSync(path.join(fixturesDir, relativePath));
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

/** Ryanair's public fare-finder. Needs no key — this is the "still useful with zero
 * keys configured" baseline the brief and issue #18 both call out. */
export async function mockRyanair(target: Routable, fixture = 'ryanair/one-way-fares.json') {
	await mockJson(target, 'https://services-api.ryanair.com/**', fixture);
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
 * Both of its queries hit the same URL and are told apart by `?featureName=`, so this
 * registers two routes rather than one. Both fixtures are deliberately EMPTY: every
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

/** Airline logos (issue #119). Needs no key, and intercepts `AIRLINE_LOGO_BASE_URL`
 * imported straight from `airline-logos.ts` for the same reason `mockOsrm` above imports
 * `OSRM_BASE_URL` — a hardcoded copy of the host here could drift from the real one
 * exactly the way issue #132 already found `mockOsrm` doing.
 *
 * Not part of `mockAllKeylessProviders` below: `AirlineLogo.svelte` renders inside
 * `ResultCard`/`ItineraryTimeline` regardless of which providers a spec is exercising, so
 * this is registered globally for every spec in `fixtures.ts` instead — a static asset
 * dependency of the UI itself, not a provider a test opts into. Kept exported here, next
 * to every other mock, so a spec that wants different logo behaviour (a failure, to check
 * the monogram fallback, say) can still call this directly with its own fixture. */
export async function mockAirlineLogos(target: Routable, fixture = 'airline-logos/logo.png') {
	const body = loadBinaryFixture(fixture);
	await target.route(`${AIRLINE_LOGO_BASE_URL}/**`, async (route) => {
		await route.fulfill({ status: 200, contentType: 'image/png', body });
	});
}

/** Registers every keyless provider (Ryanair — the fare-finder and active-airports, both
 * real endpoints the adapter calls — Transitous, OSRM). This is the state a first-time
 * visitor with an empty key store is in — see issue #18's "first run with no keys"
 * scenario and issue #3 (the key store). Airline logos are mocked separately and
 * globally — see `mockAirlineLogos`'s own doc comment for why. */
export async function mockAllKeylessProviders(target: Routable) {
	await mockRyanair(target);
	await mockRyanairActiveAirports(target);
	await mockKiwiPublic(target);
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
