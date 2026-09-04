import { describe, expect, it } from 'vitest';
import searchOneWayBcnVie from './fixtures/flights-sky-search-one-way-bcn-vie.json';
import { FlightsSkyMalformedOfferResponseError, mapSearchOneWayToOffers } from './flights-sky-map-offers';

const timeZones = new Map([
	['BCN', 'Europe/Madrid'],
	['VIE', 'Europe/Vienna']
]);
const options = { currency: 'EUR', travellers: 1, timeZones };

describe('mapSearchOneWayToOffers', () => {
	it('maps only the direct itineraries from the real captured fixture', () => {
		// The real fixture has 10 itineraries, 4 of which are one-stop connections
		// (stopCount: 1) — those are the itinerary builder's job, not this adapter's, so
		// only the 6 direct ones should come out.
		const { offers, unresolvedTimeZoneAirports } = mapSearchOneWayToOffers(searchOneWayBcnVie, options);
		expect(offers).toHaveLength(6);
		expect(unresolvedTimeZoneAirports.size).toBe(0);
	});

	it('maps the cheapest direct itinerary field-for-field', () => {
		const { offers } = mapSearchOneWayToOffers(searchOneWayBcnVie, options);
		const [offer] = offers;
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

	/** Real, otherwise-mappable itinerary shape confirmed live for issue #124: Flights Sky's
	 * search-one-way for BVC -> LGW returned a genuine nonstop TUI fare (flight 259, EUR 162,
	 * 2026-10-06T12:40 -> 20:30) that the old, un-unified flights-sky-timezone.ts silently
	 * dropped because BVC was not in its hand-curated table — the exact bug this test and
	 * `unresolvedTimeZoneAirports` exist to catch happening again. */
	function boaVistaFixture() {
		return {
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
	}

	it('drops an itinerary whose airport has no known time zone rather than mistiming it', () => {
		const { offers } = mapSearchOneWayToOffers(boaVistaFixture(), { ...options, timeZones: new Map([['VIE', 'Europe/Vienna']]) });
		expect(offers).toEqual([]);
	});

	it('reports which airport blocked an otherwise-real, otherwise-mappable itinerary', () => {
		const { offers, unresolvedTimeZoneAirports } = mapSearchOneWayToOffers(boaVistaFixture(), {
			...options,
			timeZones: new Map([['VIE', 'Europe/Vienna']]) // XXX deliberately absent
		});
		expect(offers).toEqual([]);
		expect(unresolvedTimeZoneAirports).toEqual(new Set(['XXX']));
	});

	it('never reports an ordinary stopover fare as an unresolved time zone', () => {
		// A one-stop itinerary is dropped for having a layover, long before the time zone
		// lookup ever runs — it must not show up as "we almost had this one."
		const raw = {
			data: {
				itineraries: [
					{
						price: { raw: 50 },
						legs: [
							{
								origin: { id: 'BCN' },
								destination: { id: 'VIE' },
								stopCount: 1,
								durationInMinutes: 300,
								segments: [
									{
										departure: '2026-09-19T08:00:00',
										arrival: '2026-09-19T09:00:00',
										flightNumber: '1',
										marketingCarrier: { displayCode: 'FR', name: 'Ryanair' }
									},
									{
										departure: '2026-09-19T10:00:00',
										arrival: '2026-09-19T12:00:00',
										flightNumber: '2',
										marketingCarrier: { displayCode: 'FR', name: 'Ryanair' }
									}
								]
							}
						]
					}
				]
			}
		};
		const { offers, unresolvedTimeZoneAirports } = mapSearchOneWayToOffers(raw, options);
		expect(offers).toEqual([]);
		expect(unresolvedTimeZoneAirports.size).toBe(0);
	});

	it('throws FlightsSkyMalformedOfferResponseError when data.itineraries is missing entirely', () => {
		expect(() => mapSearchOneWayToOffers({ data: { notItineraries: [] } }, options)).toThrow(
			FlightsSkyMalformedOfferResponseError
		);
	});
});
