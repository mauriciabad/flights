import { describe, expect, it } from 'vitest';
import oneWayFixture from './fixtures/kiwi-one-way-bcn-otp.json';
import {
	assertValidOneWayResponse,
	collectIataCodes,
	isSelfTransferItinerary,
	KiwiMalformedResponseError,
	mapResponseToDirectDestinations,
	mapResponseToFlightOffers
} from './kiwi-mapper';
import type { KiwiOneWayResponse } from './kiwi-types';

const fixture = oneWayFixture as KiwiOneWayResponse;
const requestedBags = { handbags: 1, holdbags: 0 };
// BCN, VIE, OTP are all in this app's own airport dataset — real ISO country codes, not
// invented ones, so this test exercises the same table kiwi-timezone.ts ships with.
const countryCodeByIataCode = { BCN: 'ES', VIE: 'AT', OTP: 'RO' };

describe('mapResponseToFlightOffers', () => {
	it('does NOT flatten a self-transfer itinerary into one offer: it emits one FlightOffer per real flight', () => {
		const offers = mapResponseToFlightOffers(fixture, requestedBags, countryCodeByIataCode);

		// Fixture has one nonstop itinerary (1 segment) and one self-transfer itinerary
		// (2 segments) = 3 real flights total, not 2 "itineraries".
		expect(offers).toHaveLength(3);

		const bcnVieOffers = offers.filter((o) => o.departureAirport === 'BCN' && o.arrivalAirport === 'VIE');
		expect(bcnVieOffers).toHaveLength(2); // the nonstop one AND the first leg of the self-transfer one
		const vieOtpOffer = offers.find((o) => o.departureAirport === 'VIE' && o.arrivalAirport === 'OTP');
		expect(vieOtpOffer).toBeDefined();
	});

	it('maps each leg with its own carrier, flight number, price and timezone-aware duration', () => {
		const offers = mapResponseToFlightOffers(fixture, requestedBags, countryCodeByIataCode);
		const bcnVie = offers.find((o) => o.departureAirport === 'BCN' && o.arrivalAirport === 'VIE');
		const vieOtp = offers.find((o) => o.departureAirport === 'VIE' && o.arrivalAirport === 'OTP');

		expect(bcnVie).toMatchObject({
			carrier: { iataCode: 'VY', name: 'VY' },
			flightNumber: 'VY8472',
			duration: 125, // 2h05m, matches Vueling VY8472 on this app's own homepage example
			price: { minorUnits: 4550, currency: 'EUR' },
			departure: { local: '2026-10-13T09:10:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
			arrival: { local: '2026-10-13T11:15:00', timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 }
		});

		expect(vieOtp).toMatchObject({
			carrier: { iataCode: 'W6', name: 'W6' },
			flightNumber: 'W64322',
			duration: 110, // 1h50m, matches Wizz W64322 on the same homepage example
			price: { minorUnits: 3275, currency: 'EUR' },
			departure: { local: '2026-10-16T14:05:00', timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 },
			arrival: { local: '2026-10-16T16:55:00', timeZone: 'Europe/Bucharest', utcOffsetMinutes: 180 }
		});
	});

	it('does not use the bundled itinerary price for either individual leg', () => {
		const offers = mapResponseToFlightOffers(fixture, requestedBags, countryCodeByIataCode);
		const combinedPriceMinorUnits = 7825; // itinerary.price = 78.25
		for (const offer of offers) {
			expect(offer.price.minorUnits).not.toBe(combinedPriceMinorUnits);
		}
	});

	it('echoes the requested bag counts onto every offer, since Kiwi gives no per-offer included-bags field', () => {
		const offers = mapResponseToFlightOffers(fixture, { handbags: 2, holdbags: 1 }, countryCodeByIataCode);
		for (const offer of offers) {
			expect(offer.baggage).toEqual({ cabinBagsIncluded: 2, checkedBagsIncluded: 1 });
		}
	});

	it('drops an itinerary with no deep link at all, rather than emitting an offer with an empty booking link', () => {
		const withoutLink: KiwiOneWayResponse = {
			currency: 'eur',
			data: [{ ...fixture.data[0], deep_link: undefined }]
		};
		expect(mapResponseToFlightOffers(withoutLink, requestedBags, countryCodeByIataCode)).toHaveLength(0);
	});

	it('drops a segment with no price, rather than guessing one', () => {
		const withUnpricedSegment: KiwiOneWayResponse = {
			currency: 'eur',
			data: [
				{
					...fixture.data[0],
					route: [{ ...fixture.data[0].route[0], price: undefined }]
				}
			]
		};
		expect(mapResponseToFlightOffers(withUnpricedSegment, requestedBags, countryCodeByIataCode)).toHaveLength(0);
	});
});

describe('isSelfTransferItinerary', () => {
	it('is false for a nonstop itinerary', () => {
		expect(isSelfTransferItinerary(fixture.data[0])).toBe(false);
	});

	it('is true for a self-transfer itinerary, via route length and the bags_recheck_required marker', () => {
		expect(isSelfTransferItinerary(fixture.data[1])).toBe(true);
	});
});

describe('collectIataCodes', () => {
	it('collects every distinct airport code mentioned anywhere in the response', () => {
		expect(new Set(collectIataCodes(fixture))).toEqual(new Set(['BCN', 'VIE', 'OTP']));
	});
});

describe('mapResponseToDirectDestinations', () => {
	it('includes only nonstop-itinerary destinations, not a self-transfer connection', () => {
		// The fixture's only nonstop itinerary is BCN->VIE. OTP is reachable only via the
		// 2-segment self-transfer itinerary, so it must NOT show up here — that itinerary
		// is a real connection, not a direct flight (types.ts: listDirectDestinations
		// promises direct flights only).
		expect(mapResponseToDirectDestinations(fixture)).toEqual(['VIE']);
	});
});

/**
 * This adapter's shape was never confirmed against a live response (this file's header),
 * so every entry point must validate before reading — these tests exist because that
 * validation is the actual fix, not the mapping behaviour above, which was already
 * covered. Each case is a field this file genuinely reads; a field it never touches
 * (e.g. `itinerary.id`) is deliberately not tested here, matching "explicit checks on the
 * fields you consume are enough."
 */
describe('runtime validation of an unverified shape', () => {
	const validSegment = fixture.data[0].route[0];
	const validItinerary = fixture.data[0];

	function expectMalformed(raw: unknown): void {
		expect(() => mapResponseToFlightOffers(raw, requestedBags, countryCodeByIataCode)).toThrow(
			KiwiMalformedResponseError
		);
		expect(() => collectIataCodes(raw)).toThrow(KiwiMalformedResponseError);
		expect(() => mapResponseToDirectDestinations(raw)).toThrow(KiwiMalformedResponseError);
		expect(() => assertValidOneWayResponse(raw)).toThrow(KiwiMalformedResponseError);
	}

	it('rejects a response that is not an object', () => {
		expectMalformed(null);
		expectMalformed('a string, not a response');
		expectMalformed(42);
	});

	it('rejects a response missing a string currency', () => {
		expectMalformed({ data: [] });
		expectMalformed({ currency: 123, data: [] });
	});

	it('rejects a response whose data is not an array', () => {
		expectMalformed({ currency: 'eur', data: {} });
	});

	it('rejects an itinerary that is not an object', () => {
		expectMalformed({ currency: 'eur', data: ['not-an-object'] });
	});

	it('rejects an itinerary whose deep_link is present but not a string', () => {
		expectMalformed({ currency: 'eur', data: [{ ...validItinerary, deep_link: 42 }] });
	});

	it('rejects an itinerary whose route is not an array', () => {
		expectMalformed({ currency: 'eur', data: [{ ...validItinerary, route: 'not-an-array' }] });
	});

	it.each([
		['flyFrom', { flyFrom: undefined }],
		['flyFrom', { flyFrom: 123 }],
		['flyTo', { flyTo: undefined }],
		['airline', { airline: '' }],
		['flight_no', { flight_no: '8472' }],
		['flight_no', { flight_no: Number.NaN }],
		['dTime', { dTime: '2026-10-13T09:10:00' }],
		['aTime', { aTime: undefined }],
		['dTimeUTC', { dTimeUTC: null }],
		['aTimeUTC', { aTimeUTC: undefined }],
		['price', { price: '45.50' }],
		['return', { return: 2 }],
		['return', { return: 'outbound' }],
		['bags_recheck_required', { bags_recheck_required: 'yes' }]
	])('rejects a segment with a bad %s field', (_field, override) => {
		expectMalformed({
			currency: 'eur',
			data: [{ ...validItinerary, route: [{ ...validSegment, ...override }] }]
		});
	});

	it('rejects the whole response when only the SECOND itinerary has a bad segment', () => {
		// Deliberately stricter than Skyscanner's per-itinerary leniency (this file's
		// header) — an otherwise-valid first itinerary does not save a response whose
		// second itinerary doesn't match this adapter's assumptions.
		expectMalformed({
			currency: 'eur',
			data: [validItinerary, { ...validItinerary, route: [{ ...validSegment, dTime: 'nope' }] }]
		});
	});

	it('accepts a segment with no price and no bags_recheck_required at all, since both are genuinely optional', () => {
		const { price: _price, bags_recheck_required: _flag, ...segmentWithoutOptionals } = validSegment;
		expect(() =>
			assertValidOneWayResponse({
				currency: 'eur',
				data: [{ ...validItinerary, route: [segmentWithoutOptionals] }]
			})
		).not.toThrow();
	});
});
