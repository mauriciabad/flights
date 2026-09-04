import { describe, expect, it } from 'vitest';
import { buildDemoComparedItineraries } from './demo-fixtures';

/**
 * `/comparator/?demo=1` is a real, public URL rendering real components, so a screenshot
 * of it looks exactly like a screenshot of the app working. This project has already lost
 * a morning to an agent reporting a mocked itinerary as a live result, so the demo data
 * has to be recognisable as fake without reading the source (docs/ACCEPTANCE.md, "Never
 * ship a flight that does not exist").
 *
 * These are not tests of the demo's shape — `Comparator.test.ts` and
 * `tests/e2e/comparator.spec.ts` own that. They are tests that nothing here could ever be
 * mistaken for a bookable trip.
 */

const FIXTURE_TOKEN = 'FIXTURE';
/** No fare or hostel bed costs four figures in euro. Anything cheaper than this would
 * start to read like a real price on screen. */
const IMPLAUSIBLE_MINOR_UNITS = 500_000;

describe('comparator demo fixtures are unmistakably fake', () => {
	const items = buildDemoComparedItineraries();

	it('builds the three columns the subgrid alignment check needs', () => {
		expect(items).toHaveLength(3);
	});

	it('names every airline, airport, city and property FIXTURE', () => {
		for (const { itinerary } of items) {
			for (const flight of [itinerary.outboundFlight, itinerary.onwardFlight]) {
				expect(flight.carrier.name).toContain(FIXTURE_TOKEN);
			}
			for (const airport of [itinerary.originAirport, itinerary.destinationAirport]) {
				expect(airport.name).toContain(FIXTURE_TOKEN);
				expect(airport.city.name).toContain(FIXTURE_TOKEN);
				expect(airport.country.name).toContain(FIXTURE_TOKEN);
			}
			if (itinerary.stay) expect(itinerary.stay.property.name).toContain(FIXTURE_TOKEN);
		}
	});

	it('uses IATA codes that belong to no airport and no airline', () => {
		for (const { itinerary } of items) {
			for (const code of [
				itinerary.originAirport.iataCode,
				itinerary.destinationAirport.iataCode,
				itinerary.outboundFlight.arrivalAirport
			]) {
				// The OurAirports dataset this app ships holds no code starting with ZZ,
				// so none of these resolves to a place a traveller could fly to.
				expect(code.startsWith('ZZ')).toBe(true);
			}
			for (const flight of [itinerary.outboundFlight, itinerary.onwardFlight]) {
				// ZZ/ZY/ZX/ZW are unassigned IATA airline designators, and no airline
				// numbers a flight 0000.
				expect(flight.flightNumber).toMatch(/^ZZ000\d$/);
				expect(flight.carrier.iataCode).toMatch(/^Z[ZYXW]$/);
			}
		}
	});

	it('prices everything far outside anything a person would book', () => {
		for (const { itinerary } of items) {
			for (const flight of [itinerary.outboundFlight, itinerary.onwardFlight]) {
				expect(flight.price.minorUnits).toBeGreaterThan(IMPLAUSIBLE_MINOR_UNITS);
			}
			if (itinerary.stay) {
				expect(itinerary.stay.pricePerNight.minorUnits).toBeGreaterThan(IMPLAUSIBLE_MINOR_UNITS);
			}
			expect(itinerary.totalPrice.minorUnits).toBeGreaterThan(IMPLAUSIBLE_MINOR_UNITS);
		}
	});

	it('never imitates the acceptance route', () => {
		// docs/ACCEPTANCE.md: BVC -> PFO is the one trip that decides whether this project
		// works. A mock of it is the one mock nobody can sanity-check by eye.
		const codes = items.flatMap(({ itinerary }) => [
			itinerary.originAirport.iataCode,
			itinerary.destinationAirport.iataCode,
			itinerary.outboundFlight.arrivalAirport
		]);
		expect(codes).not.toContain('BVC');
		expect(codes).not.toContain('PFO');
	});
});
