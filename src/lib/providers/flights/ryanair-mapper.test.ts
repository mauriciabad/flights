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

	// Issue #93: `valueMainUnit` renamed, retyped, or otherwise missing used to reach
	// `Number.parseInt` unchecked and come back `NaN` — a number, so nothing downstream
	// noticed a price had stopped being a real one. Every case below must drop the fare
	// instead.
	it('drops a fare whose price.valueMainUnit is missing rather than reporting NaN', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const corrupted = structuredClone(response.fares[0]);
		// @ts-expect-error deliberately corrupting a required field to simulate a Ryanair
		// schema drift.
		delete corrupted.outbound.price.valueMainUnit;
		expect(mapFareToFlightOffer(corrupted, timeZones)).toBeUndefined();
	});

	it('drops a fare whose price.valueMainUnit was retyped to a number', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const corrupted = structuredClone(response.fares[0]);
		// @ts-expect-error deliberately corrupting a required field to simulate a Ryanair
		// schema drift.
		corrupted.outbound.price.valueMainUnit = 14;
		expect(mapFareToFlightOffer(corrupted, timeZones)).toBeUndefined();
	});

	it('drops a fare whose price.valueFractionalUnit was retyped to null', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const corrupted = structuredClone(response.fares[0]);
		// @ts-expect-error deliberately corrupting a required field to simulate a Ryanair
		// schema drift.
		corrupted.outbound.price.valueFractionalUnit = null;
		expect(mapFareToFlightOffer(corrupted, timeZones)).toBeUndefined();
	});

	it('drops a fare whose price is missing entirely', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const corrupted = structuredClone(response.fares[0]);
		// @ts-expect-error deliberately corrupting a required field to simulate a Ryanair
		// schema drift.
		delete corrupted.outbound.price;
		expect(mapFareToFlightOffer(corrupted, timeZones)).toBeUndefined();
	});

	it('drops a fare whose flightNumber is missing, since the cross-check matches on it', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const corrupted = structuredClone(response.fares[0]);
		corrupted.outbound.flightNumber = '';
		expect(mapFareToFlightOffer(corrupted, timeZones)).toBeUndefined();
	});

	it('drops a fare whose departureDate is not a parsable ISO string, instead of throwing', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const corrupted = structuredClone(response.fares[0]);
		corrupted.outbound.departureDate = 'not-a-date';
		expect(() => mapFareToFlightOffer(corrupted, timeZones)).not.toThrow();
		expect(mapFareToFlightOffer(corrupted, timeZones)).toBeUndefined();
	});

	it('drops a fare whose arrivalDate was retyped to null, instead of throwing', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const corrupted = structuredClone(response.fares[0]);
		// @ts-expect-error deliberately corrupting a required field to simulate a Ryanair
		// schema drift.
		corrupted.outbound.arrivalDate = null;
		expect(() => mapFareToFlightOffer(corrupted, timeZones)).not.toThrow();
		expect(mapFareToFlightOffer(corrupted, timeZones)).toBeUndefined();
	});

	it('drops a fare whose outbound is missing entirely, instead of throwing', () => {
		const response = oneWayFaresSingleFixture as RyanairOneWayFaresResponse;
		const corrupted = structuredClone(response.fares[0]);
		// @ts-expect-error deliberately corrupting a required field to simulate a Ryanair
		// schema drift.
		delete corrupted.outbound;
		expect(() => mapFareToFlightOffer(corrupted, timeZones)).not.toThrow();
		expect(mapFareToFlightOffer(corrupted, timeZones)).toBeUndefined();
	});

	it('drops a fare that is not an object at all, instead of throwing', () => {
		// @ts-expect-error deliberately passing a structurally broken fare entry.
		expect(() => mapFareToFlightOffer(null, timeZones)).not.toThrow();
		// @ts-expect-error deliberately passing a structurally broken fare entry.
		expect(mapFareToFlightOffer(null, timeZones)).toBeUndefined();
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

	it('drops one malformed fare among otherwise good ones, rather than failing the batch (issue #93)', () => {
		const response = structuredClone(oneWayFaresMultiFixture) as RyanairOneWayFaresResponse;
		// One good fare's price gets corrupted the way a Ryanair field rename would —
		// everything else about the response stays untouched.
		// @ts-expect-error deliberately corrupting a required field to simulate a Ryanair
		// schema drift.
		response.fares[0].outbound.price.valueMainUnit = undefined;

		const offers = mapFaresToFlightOffers(response, timeZones);

		// Started with 3 fares: one now-corrupted, one unknown-airport (ZZZ, pre-existing),
		// one good — only the good one survives.
		expect(offers).toHaveLength(1);
		expect(offers[0]?.flightNumber).toBe('FR3792');
		expect(offers.every((offer) => Number.isFinite(offer.price.minorUnits))).toBe(true);
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
