import { describe, expect, it } from 'vitest';
import searchFlightsBcnVie from './fixtures/search-flights-bcn-vie.json';
import { mapSearchFlightsToOffers, SkyscannerMalformedResponseError } from './skyscanner-map-offers';

// This fixture is a real Sky Scrapper response captured for issue #5 (trimmed to three of
// the eight itineraries it actually returned: one direct Vueling flight, one direct
// Ryanair/Lauda-Europe wet-lease flight, and one KLM itinerary connecting through AMS). It
// is why every test in this file needs no network: the whole point of the 5-request budget
// this issue was built under is that these fixtures, not live calls, drive the test suite.
//
// `timeZones` stands in for what skyscanner.ts resolves once per `searchOffers` call (issue
// #75) before ever reaching this pure mapper — BCN and VIE only, deliberately, so the "drops
// an itinerary at an unresolved airport" test below stays honest about what "unresolved"
// means: not present in this map, for whatever reason (seed miss, live lookup failure, or a
// lookup that was never attempted for a code this response doesn't reference).
const options = {
	currency: 'EUR',
	travellers: 1,
	timeZones: new Map([
		['BCN', 'Europe/Madrid'],
		['VIE', 'Europe/Vienna']
	])
};

describe('mapSearchFlightsToOffers', () => {
	it('maps the real fixture to exactly the two direct offers it contains', () => {
		const offers = mapSearchFlightsToOffers(searchFlightsBcnVie, options).offers;
		expect(offers).toHaveLength(2);
		expect(offers.map((offer) => offer.flightNumber)).toEqual(['VY8714', 'FR12']);
	});

	it('drops the one-stop itinerary rather than inventing a single-flight price for it', () => {
		const offers = mapSearchFlightsToOffers(searchFlightsBcnVie, options).offers;
		expect(offers.some((offer) => offer.price.minorUnits === 10213)).toBe(false);
	});

	it('keeps local wall-clock time and attaches the correct offset for each end', () => {
		const [vueling] = mapSearchFlightsToOffers(searchFlightsBcnVie, options).offers;
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
		const [vueling] = mapSearchFlightsToOffers(searchFlightsBcnVie, options).offers;
		// price.raw is 17.99, price.formatted is the already-rounded "18 €" (see the
		// fixture). Money must come from raw, or every price would be off by up to a unit.
		expect(vueling.price).toEqual({ minorUnits: 1799, currency: 'EUR' });
	});

	it('declares its price as already covering the whole party (issue #109)', () => {
		// Measured live 2026-09-04, same BCN-DUB route and date, only `adults` changed:
		// 1 adult 336.51/588.97, 3 adults 966.21/1766.38. 588.97 * 3 = 1766.91, not
		// 1766.38 — Sky Scrapper's price already scales with the `adults` this adapter
		// requests (`options.travellers`, sent as skyscanner.ts's own `adults: String(travellers)`),
		// so the itinerary builder must not multiply it again.
		const [vueling] = mapSearchFlightsToOffers(searchFlightsBcnVie, options).offers;
		expect(vueling.priceScope).toBe('party-total');
	});

	it('uses the marketing carrier, not the operating carrier, for a wet-lease flight', () => {
		const offers = mapSearchFlightsToOffers(searchFlightsBcnVie, options).offers;
		const ryanairSold = offers.find((offer) => offer.flightNumber === 'FR12');
		// The fixture's second offer is sold as Ryanair (marketingCarrier "FR") but flown
		// by Lauda Europe (operatingCarrier "LW"). The traveller books and pays Ryanair.
		expect(ryanairSold?.carrier).toEqual({ iataCode: 'FR', name: 'Ryanair' });
	});

	it('builds a route-and-date deep link, since Sky Scrapper gives no per-offer booking URL', () => {
		const [vueling] = mapSearchFlightsToOffers(searchFlightsBcnVie, options).offers;
		expect(vueling.deepLink).toBe(
			'https://www.skyscanner.net/transport/flights/bcn/vie/261015/?adultsv2=1&cabinclass=economy&currency=EUR&rtn=0'
		);
	});

	it('marks baggage as zero-and-unverified rather than omitting it, since the field is required', () => {
		const [vueling] = mapSearchFlightsToOffers(searchFlightsBcnVie, options).offers;
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
		const result = mapSearchFlightsToOffers(allConnections, options);
		expect(result.offers).toEqual([]);
		// A bundled stopover is an itinerary this app declines to model, not one it failed
		// to date. Reporting it here would make skyscanner.ts call an ordinary
		// connections-only response a time zone failure.
		expect([...result.unresolvedTimeZoneAirports]).toEqual([]);
	});

	it('drops an itinerary landing at an airport whose time zone could not be resolved', () => {
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
		const result = mapSearchFlightsToOffers(unknownAirport, options);
		expect(result.offers).toEqual([]);
		// Issue #370: dropped AND named. This itinerary is nonstop, priced, carrier-named
		// and duration-bearing — the zone is the only thing missing, which is what makes it
		// worth telling skyscanner.ts about rather than counting as an empty route.
		expect([...result.unresolvedTimeZoneAirports]).toEqual(['XXX']);
	});
});
