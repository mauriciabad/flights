import { describe, expect, it } from 'vitest';
import searchFlightsBcnVie from './fixtures/search-flights-bcn-vie.json';
import { mapSearchFlightsToOffers, SkyscannerMalformedResponseError } from './skyscanner-map-offers';

// This fixture is a real Sky Scrapper response captured for issue #5 (trimmed to three of
// the eight itineraries it actually returned: one direct Vueling flight, one direct
// Ryanair/Lauda-Europe wet-lease flight, and one KLM itinerary connecting through AMS). It
// is why every test in this file needs no network: the whole point of the 5-request budget
// this issue was built under is that these fixtures, not live calls, drive the test suite.
const options = { currency: 'EUR', travellers: 1 };

describe('mapSearchFlightsToOffers', () => {
	it('maps the real fixture to exactly the two direct offers it contains', () => {
		const offers = mapSearchFlightsToOffers(searchFlightsBcnVie, options);
		expect(offers).toHaveLength(2);
		expect(offers.map((offer) => offer.flightNumber)).toEqual(['VY8714', 'FR12']);
	});

	it('drops the one-stop itinerary rather than inventing a single-flight price for it', () => {
		const offers = mapSearchFlightsToOffers(searchFlightsBcnVie, options);
		expect(offers.some((offer) => offer.price.minorUnits === 10213)).toBe(false);
	});

	it('keeps local wall-clock time and attaches the correct offset for each end', () => {
		const [vueling] = mapSearchFlightsToOffers(searchFlightsBcnVie, options);
		expect(vueling.departure).toEqual({
			local: '2026-10-15T08:05:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
		expect(vueling.arrival).toEqual({
			local: '2026-10-15T10:35:00',
			timeZone: 'Europe/Vienna',
			utcOffsetMinutes: 120
		});
	});

	it('converts the real raw price into integer minor units, not the rounded display string', () => {
		const [vueling] = mapSearchFlightsToOffers(searchFlightsBcnVie, options);
		// price.raw is 17.99, price.formatted is the already-rounded "18 €" (see the
		// fixture). Money must come from raw, or every price would be off by up to a unit.
		expect(vueling.price).toEqual({ minorUnits: 1799, currency: 'EUR' });
	});

	it('uses the marketing carrier, not the operating carrier, for a wet-lease flight', () => {
		const offers = mapSearchFlightsToOffers(searchFlightsBcnVie, options);
		const ryanairSold = offers.find((offer) => offer.flightNumber === 'FR12');
		// The fixture's second offer is sold as Ryanair (marketingCarrier "FR") but flown
		// by Lauda Europe (operatingCarrier "LW"). The traveller books and pays Ryanair.
		expect(ryanairSold?.carrier).toEqual({ iataCode: 'FR', name: 'Ryanair' });
	});

	it('builds a route-and-date deep link, since Sky Scrapper gives no per-offer booking URL', () => {
		const [vueling] = mapSearchFlightsToOffers(searchFlightsBcnVie, options);
		expect(vueling.deepLink).toBe(
			'https://www.skyscanner.net/transport/flights/bcn/vie/261015/?adultsv2=1&cabinclass=economy&currency=EUR&rtn=0'
		);
	});

	it('marks baggage as zero-and-unverified rather than omitting it, since the field is required', () => {
		const [vueling] = mapSearchFlightsToOffers(searchFlightsBcnVie, options);
		expect(vueling.baggage).toEqual({ cabinBagsIncluded: 0, checkedBagsIncluded: 0 });
	});

	it('throws SkyscannerMalformedResponseError when the top-level shape is unrecognisable', () => {
		expect(() => mapSearchFlightsToOffers({ status: true }, options)).toThrow(
			SkyscannerMalformedResponseError
		);
		expect(() => mapSearchFlightsToOffers('not even an object', options)).toThrow(
			SkyscannerMalformedResponseError
		);
	});

	it('returns an empty array, not an error, when every itinerary is unmappable', () => {
		const allConnections = {
			data: {
				itineraries: [
					{ legs: [{ stopCount: 1, segments: [{}, {}] }] },
					{ legs: [{ stopCount: 2, segments: [{}, {}, {}] }] }
				]
			}
		};
		expect(mapSearchFlightsToOffers(allConnections, options)).toEqual([]);
	});

	it('drops an itinerary landing at an airport outside the curated time zone table', () => {
		const unknownAirport = {
			data: {
				itineraries: [
					{
						price: { raw: 50 },
						legs: [
							{
								stopCount: 0,
								origin: { id: 'BCN' },
								destination: { id: 'XXX' },
								departure: '2026-10-15T08:00:00',
								arrival: '2026-10-15T10:00:00',
								durationInMinutes: 120,
								segments: [
									{
										departure: '2026-10-15T08:00:00',
										arrival: '2026-10-15T10:00:00',
										flightNumber: '100',
										marketingCarrier: { displayCode: 'XX', name: 'Unmapped Air' }
									}
								]
							}
						]
					}
				]
			}
		};
		expect(mapSearchFlightsToOffers(unknownAirport, options)).toEqual([]);
	});
});
