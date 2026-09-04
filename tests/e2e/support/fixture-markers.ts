// The import attribute is not optional: Playwright transpiles this file to real ESM and
// Node refuses a JSON module without it.
import markers from '../fixtures/markers.json' with { type: 'json' };

/**
 * The one place a spec or a fixture gets its "this is not a real result" values from.
 *
 * An agent reported the app returning "BVC -> LGW -> PFO, EUR 238, via Ryanair" and was
 * reading a mock: the fixture that answered was built to match the owner's reference
 * itinerary exactly — his route, his dates, his two leg prices adding up to his EUR 238.
 * Nothing about the answer could tell it apart from the app actually working, which is
 * the flaw. A fixture is a stand-in for a provider's answer, so it has to be shaped like
 * one, but it must never be *valuable* as one.
 *
 * So every mocked payload carries at least one token from `markers.json`, prices come
 * from a band no real fare or hostel night lands in, and flight numbers come from a pool
 * that cannot exist. `tools/probe-results.mjs` reads the same manifest and refuses to
 * report an itinerary count when it finds a token, so a leaked mock fails loudly instead
 * of being written up as a working search.
 */

/** Appears somewhere in every mock provider payload. Uppercase on purpose: no airport,
 * city, airline or hotel is called this, and nothing in `src/` renders the word. */
export const FIXTURE_TEXT_TOKEN = markers.textToken;

/** Impossible flight numbers, in the order a spec should reach for them. `ZZ` is not an
 * assigned IATA airline designator, and no airline numbers a flight 0000. */
export const FIXTURE_FLIGHT_NUMBERS = markers.flightNumbers;

/** Every token `probe-results.mjs` and `guard.spec.ts` scan for. */
export const FIXTURE_MARKER_TOKENS: readonly string[] = [markers.textToken, ...markers.flightNumbers];

/**
 * Fare prices for mocks, in euro major units.
 *
 * Five figures for a Ryanair hop and for a hostel bed, with repeating cents, so a leaked
 * total reads as nonsense to anyone who glances at it. They are also pairwise distinct
 * and their sums are unambiguous, so a test asserting a total still proves the app added
 * the right two numbers.
 */
export const FIXTURE_PRICES = {
	/** €9,111.11 */
	first: 9111.11,
	/** €9,222.22 */
	second: 9222.22,
	/** €9,333.33 */
	third: 9333.33,
	/** €9,444.44 — used for stays, per night. */
	perNight: 9444.44
} as const;

/** Place names for mocks. Real IATA codes stay real: the app resolves a code against its
 * own OurAirports dataset (`src/lib/data/airports.ts`) for coordinates, city and
 * timezone, so a synthetic code returns no itinerary at all and the test stops exercising
 * the pipeline it exists to exercise. The names a provider *sends* carry the marker
 * instead, which is what lands in the response body a probe reads. */
export const FIXTURE_NAMES = {
	airportA: `${markers.textToken} Alpha`,
	airportB: `${markers.textToken} Bravo`,
	airportC: `${markers.textToken} Charlie`,
	country: `${markers.textToken}LAND`,
	city: `${markers.textToken}LAND`,
	carrier: `${markers.textToken} Airways`,
	property: `${markers.textToken} Lodge`
} as const;
