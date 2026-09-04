import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function loadFixture(relativePath: string): string {
	return readFileSync(path.join(fixturesDir, relativePath), 'utf-8');
}

/** Anything that can register a route: a `BrowserContext`, or a single `Page`. */
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

/** Transitous/MOTIS public transport timetables. Needs no key. */
export async function mockTransitous(target: Routable, fixture = 'transitous/plan.json') {
	await mockJson(target, 'https://api.transitous.org/**', fixture);
}

/** OSRM walking/driving times and routes. Needs no key. */
export async function mockOsrm(target: Routable, fixture = 'osrm/route.json') {
	await mockJson(target, 'https://router.project-osrm.org/**', fixture);
}

/** Registers every keyless provider (Ryanair, Transitous, OSRM). This is the state a
 * first-time visitor with an empty key store is in — see issue #18's "first run with no
 * keys" scenario and issue #3 (the key store). */
export async function mockAllKeylessProviders(target: Routable) {
	await mockRyanair(target);
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
