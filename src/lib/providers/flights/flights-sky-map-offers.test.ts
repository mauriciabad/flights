import { describe, expect, it } from 'vitest';
import searchOneWayBcnVie from './fixtures/flights-sky-search-one-way-bcn-vie.json';
import { FlightsSkyMalformedOfferResponseError, mapSearchOneWayToOffers } from './flights-sky-map-offers';

const options = { currency: 'EUR', travellers: 1 };

describe('mapSearchOneWayToOffers', () => {
	it('maps only the direct itineraries from the real captured fixture', () => {
		// The real fixture has 10 itineraries, 4 of which are one-stop connections
		// (stopCount: 1) — those are the itinerary builder's job, not this adapter's, so
		// only the 6 direct ones should come out.
		const offers = mapSearchOneWayToOffers(searchOneWayBcnVie, options);
		expect(offers).toHaveLength(6);
	});

	it('maps the cheapest direct itinerary field-for-field', () => {
		const [offer] = mapSearchOneWayToOffers(searchOneWayBcnVie, options);
		expect(offer).toMatchObject({
			carrier: { iataCode: 'FR', name: 'Ryanair' },
			flightNumber: 'FR12',
			departureAirport: 'BCN',
			arrivalAirport: 'VIE',
			duration: 145,
			price: { minorUnits: 6099, currency: 'EUR' },
			// Issue #109: `search-one-way`'s own request shape has no adults field at all
			// (flights-sky-client.ts's `SearchOneWayParams`), so this is a per-adult fare by
			// construction, never a party total to double-count.
			priceScope: 'per-person',
			baggage: { cabinBagsIncluded: 0, checkedBagsIncluded: 0 }
		});
		expect(offer.departure).toEqual({
			local: '2026-09-19T08:10:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
		expect(offer.arrival).toEqual({
			local: '2026-09-19T10:35:00',
			timeZone: 'Europe/Vienna',
			utcOffsetMinutes: 120
		});
		expect(offer.deepLink).toContain('skyscanner.net/transport/flights/bcn/vie/260919');
	});

	it('drops an itinerary whose airport has no known time zone rather than mistiming it', () => {
		const raw = {
			data: {
				itineraries: [
					{
						price: { raw: 50 },
						legs: [
							{
								origin: { id: 'XXX' },
								destination: { id: 'VIE' },
								stopCount: 0,
								durationInMinutes: 120,
								segments: [
									{
										departure: '2026-09-19T08:00:00',
										arrival: '2026-09-19T10:00:00',
										flightNumber: '1',
										marketingCarrier: { displayCode: 'FR', name: 'Ryanair' }
									}
								]
							}
						]
					}
				]
			}
		};
		expect(mapSearchOneWayToOffers(raw, options)).toEqual([]);
	});

	it('throws FlightsSkyMalformedOfferResponseError when data.itineraries is missing entirely', () => {
		expect(() => mapSearchOneWayToOffers({ data: { notItineraries: [] } }, options)).toThrow(
			FlightsSkyMalformedOfferResponseError
		);
	});
});
