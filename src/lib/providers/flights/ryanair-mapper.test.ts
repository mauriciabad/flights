import { describe, expect, it } from 'vitest';
import activeAirportsFixture from './fixtures/active-airports.json';
import oneWayFaresMultiFixture from './fixtures/one-way-fares-multi.json';
import oneWayFaresSingleFixture from './fixtures/one-way-fares-single-route.json';
import routesBcnFixture from './fixtures/routes-bcn.json';
import {
	buildTimeZoneIndex,
	mapFareToFlightOffer,
	mapFaresToFlightOffers,
	mapRoutesToDestinations,
	RYANAIR_CARRIER
} from './ryanair-mapper';
import type { RyanairOneWayFaresResponse, RyanairRoutesResponse } from './ryanair-types';

const timeZones = buildTimeZoneIndex(activeAirportsFixture);

describe('buildTimeZoneIndex', () => {
	it('projects the active-airports fixture down to iataCode -> timeZone', () => {
		expect(timeZones).toEqual({
			BCN: 'Europe/Madrid',
			STN: 'Europe/London',
			AHO: 'Europe/Rome',
			BHX: 'Europe/London'
		});
	});
});

describe('mapFareToFlightOffer', () => {
	it('maps a real captured BCN -> STN fare to the exact domain shape (issue #17\'s shape: flight number, date, carrier, price)', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const offer = mapFareToFlightOffer(response.fares[0], timeZones);

		expect(offer).toEqual({
			carrier: RYANAIR_CARRIER,
			flightNumber: 'FR8231',
			departureAirport: 'BCN',
			arrivalAirport: 'STN',
			departure: { local: '2026-10-13T09:10:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
			arrival: { local: '2026-10-13T10:35:00', timeZone: 'Europe/London', utcOffsetMinutes: 60 },
			duration: 145,
			price: { minorUnits: 1499, currency: 'EUR' },
			fareBrand: 'Basic',
			baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
			deepLink: expect.stringContaining('originIata=BCN')
		});
		expect(offer?.deepLink).toContain('destinationIata=STN');
		expect(offer?.deepLink).toContain('dateOut=2026-10-13');
	});

	it('returns undefined rather than guessing when an airport has no known timezone', () => {
		const response = oneWayFaresMultiFixture as RyanairOneWayFaresResponse;
		const zzzFare = response.fares.find((fare) => fare.outbound.arrivalAirport.iataCode === 'ZZZ');
		expect(zzzFare).toBeDefined();
		expect(mapFareToFlightOffer(zzzFare!, timeZones)).toBeUndefined();
	});

	it('carries the currency the response actually returned, not an assumed one', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const gbpFare = structuredClone(response.fares[0]);
		gbpFare.outbound.price = {
			value: 12.34,
			valueMainUnit: '12',
			valueFractionalUnit: '34',
			currencyCode: 'GBP',
			currencySymbol: '£'
		};
		const offer = mapFareToFlightOffer(gbpFare, timeZones);
		expect(offer?.price).toEqual({ minorUnits: 1234, currency: 'GBP' });
	});
});

describe('mapFaresToFlightOffers', () => {
	it('drops the one fare with an unknown airport but keeps the rest', () => {
		const response = oneWayFaresMultiFixture as RyanairOneWayFaresResponse;
		const offers = mapFaresToFlightOffers(response, timeZones);

		// 3 fares in the fixture, one of them (ZZZ) has no timezone record.
		expect(offers).toHaveLength(2);
		expect(offers.map((offer) => offer.flightNumber).sort()).toEqual(['FR3792', 'FR8977']);
	});
});

describe('mapRoutesToDestinations', () => {
	it('returns a deduplicated list of destination IATA codes', () => {
		const routes = routesBcnFixture as RyanairRoutesResponse;
		const destinations = mapRoutesToDestinations(routes);

		// Fixture has AGP, AHO, and STN listed twice (a seasonal duplicate entry).
		expect(destinations.sort()).toEqual(['AGP', 'AHO', 'STN']);
	});
});
