/**
 * Every assertion here runs against payloads captured from the live endpoint on
 * 2026-09-04 (./fixtures/kiwi-public-*.json), not against handwritten shapes. The route
 * they describe is the one docs/ACCEPTANCE.md says decides whether this app works:
 * Boa Vista to Pafos, 6 October 2026, via London Gatwick.
 */

import { describe, expect, it } from 'vitest';
import bvcToLgw from './fixtures/kiwi-public-oneway-bvc-lgw.json';
import lgwToPfo from './fixtures/kiwi-public-oneway-lgw-pfo.json';
import onePerCityBvc from './fixtures/kiwi-public-oneper-city-bvc.json';
import onePerCityLgw from './fixtures/kiwi-public-oneper-city-lgw.json';
import {
	appErrorOf,
	buildKiwiDeepLink,
	mapItineraryToFlightOffer,
	mapOnePerCityResultToDestinations,
	mapOneWayResultToOffers,
	parseKiwiDurationMinutes,
	parseKiwiMoney
} from './kiwi-public-mapper';
import type { KiwiPublicItinerary } from './kiwi-public-types';

describe('parseKiwiMoney', () => {
	it('reads a whole-number amount as minor units', () => {
		expect(parseKiwiMoney('173', 'EUR')).toEqual({ minorUnits: 17300, currency: 'EUR' });
	});

	it('reads a two-decimal amount without going through a float', () => {
		// 14.99 * 100 is 1498.9999999999998 in IEEE 754, which is exactly the bug this
		// digit-wise parse exists to avoid.
		expect(parseKiwiMoney('14.99', 'EUR')).toEqual({ minorUnits: 1499, currency: 'EUR' });
	});

	it('pads a single decimal place rather than reading it as cents', () => {
		expect(parseKiwiMoney('20.5', 'EUR')).toEqual({ minorUnits: 2050, currency: 'EUR' });
	});

	it('uppercases the currency code', () => {
		expect(parseKiwiMoney('10', 'eur')?.currency).toBe('EUR');
	});

	it.each([
		['a missing amount', undefined],
		['a number instead of a string', 173],
		['a thousands separator', '1,173'],
		['scientific notation', '1.73e2'],
		['a negative amount', '-173'],
		['an empty string', '']
	])('refuses %s rather than producing NaN', (_label, amount) => {
		expect(parseKiwiMoney(amount, 'EUR')).toBeUndefined();
	});

	it('refuses a missing currency', () => {
		expect(parseKiwiMoney('173', undefined)).toBeUndefined();
	});
});

describe('parseKiwiDurationMinutes', () => {
	it('converts Kiwi seconds to domain minutes', () => {
		// The real BVC->LGW value. 21000 / 60 = 350 minutes = 5h50m, which is the gap
		// between that segment's own two local times once their offsets are applied.
		expect(parseKiwiDurationMinutes(21000)).toBe(350);
	});

	it('rounds rather than truncating', () => {
		expect(parseKiwiDurationMinutes(90)).toBe(2);
	});

	it.each([['zero', 0], ['negative', -60], ['a string', '21000'], ['undefined', undefined]])(
		'refuses %s',
		(_label, seconds) => {
			expect(parseKiwiDurationMinutes(seconds)).toBeUndefined();
		}
	);
});

describe('mapOneWayResultToOffers', () => {
	it('maps the real BVC to LGW response into one bookable offer', () => {
		const offers = mapOneWayResultToOffers(bvcToLgw.data.onewayItineraries);

		expect(offers).toHaveLength(1);
		const [offer] = offers;
		expect(offer.departureAirport).toBe('BVC');
		expect(offer.arrivalAirport).toBe('LGW');
		expect(offer.carrier).toEqual({ iataCode: 'BY', name: 'TUI Airways' });
		expect(offer.flightNumber).toBe('BY259');
		expect(offer.price).toEqual({ minorUnits: 17300, currency: 'EUR' });
		expect(offer.priceScope).toBe('per-person');
		expect(offer.duration).toBe(350);
	});

	it('keeps each end of the BVC to LGW flight in its own airport time zone', () => {
		const [offer] = mapOneWayResultToOffers(bvcToLgw.data.onewayItineraries);

		// Cape Verde is UTC-1 and London is on BST (+1) in early October, so the same
		// flight departs at 12:40 and lands at 20:30 on two clocks that are two hours
		// apart. Normalising either to UTC is exactly what AGENTS.md forbids.
		expect(offer.departure).toEqual({
			local: '2026-10-06T12:40:00',
			timeZone: 'Atlantic/Cape_Verde',
			utcOffsetMinutes: -60
		});
		expect(offer.arrival).toEqual({
			local: '2026-10-06T20:30:00',
			timeZone: 'Europe/London',
			utcOffsetMinutes: 60
		});
	});

	it('reads real baggage counts rather than assuming a fare brand', () => {
		const [offer] = mapOneWayResultToOffers(bvcToLgw.data.onewayItineraries);
		expect(offer.baggage).toEqual({ cabinBagsIncluded: 1, checkedBagsIncluded: 0 });
	});

	it('maps every offer in the real LGW to PFO response', () => {
		const offers = mapOneWayResultToOffers(lgwToPfo.data.onewayItineraries);

		expect(offers.length).toBeGreaterThan(0);
		expect(offers.every((offer) => offer.departureAirport === 'LGW')).toBe(true);
		expect(offers.every((offer) => offer.arrivalAirport === 'PFO')).toBe(true);
		// Two carriers on this route in the captured window, which is the point of using an
		// aggregator rather than one airline's own API.
		expect(new Set(offers.map((offer) => offer.carrier.iataCode)).size).toBeGreaterThan(1);
	});

	it('prices the cheapest LGW to PFO leg at what Kiwi quoted', () => {
		const offers = mapOneWayResultToOffers(lgwToPfo.data.onewayItineraries);
		const cheapest = offers.reduce((a, b) => (a.price.minorUnits <= b.price.minorUnits ? a : b));

		expect(cheapest.price).toEqual({ minorUnits: 6300, currency: 'EUR' });
		expect(cheapest.flightNumber).toBe('LS3159');
	});

	it('returns an empty list for a response with no itineraries', () => {
		expect(mapOneWayResultToOffers({ __typename: 'Itineraries', itineraries: [] })).toEqual([]);
	});

	it('returns an empty list rather than throwing when the field is missing entirely', () => {
		expect(mapOneWayResultToOffers(undefined)).toEqual([]);
	});
});

describe('mapItineraryToFlightOffer', () => {
	/** The real BVC->LGW itinerary, deep-cloned so a test can break one field of it. */
	function realItinerary(): KiwiPublicItinerary {
		return structuredClone(bvcToLgw.data.onewayItineraries.itineraries[0]) as KiwiPublicItinerary;
	}

	it('drops an itinerary with more than one segment', () => {
		const itinerary = realItinerary();
		const segments = itinerary.sector?.sectorSegments ?? [];
		itinerary.sector = { sectorSegments: [...segments, ...segments] };

		// A FlightOffer is one flight. Flattening a two-leg journey into one would describe
		// a flight nobody sells — docs/ACCEPTANCE.md's highest-severity bug.
		expect(mapItineraryToFlightOffer(itinerary)).toBeUndefined();
	});

	it('drops an itinerary whose airport has no time zone', () => {
		const itinerary = realItinerary();
		delete itinerary.sector!.sectorSegments![0].segment!.destination!.station!.timezone;

		expect(mapItineraryToFlightOffer(itinerary)).toBeUndefined();
	});

	it('drops an itinerary with no flight number, which crosscheck.ts matches on', () => {
		const itinerary = realItinerary();
		delete itinerary.sector!.sectorSegments![0].segment!.code;

		expect(mapItineraryToFlightOffer(itinerary)).toBeUndefined();
	});

	it('drops an itinerary whose price cannot be read exactly', () => {
		const itinerary = realItinerary();
		itinerary.price = { amount: 'free', currency: { code: 'EUR' } };

		expect(mapItineraryToFlightOffer(itinerary)).toBeUndefined();
	});

	it('drops an itinerary with an unparsable local time', () => {
		const itinerary = realItinerary();
		itinerary.sector!.sectorSegments![0].segment!.source!.localTime = 'sometime on Tuesday';

		expect(mapItineraryToFlightOffer(itinerary)).toBeUndefined();
	});

	it('falls back to the carrier code when the airline name is missing', () => {
		const itinerary = realItinerary();
		delete itinerary.sector!.sectorSegments![0].segment!.carrier!.name;

		expect(mapItineraryToFlightOffer(itinerary)?.carrier).toEqual({
			iataCode: 'BY',
			name: 'BY'
		});
	});

	it('reports zero bags rather than dropping the offer when bagsInfo is missing', () => {
		const itinerary = realItinerary();
		delete itinerary.bagsInfo;

		expect(mapItineraryToFlightOffer(itinerary)?.baggage).toEqual({
			cabinBagsIncluded: 0,
			checkedBagsIncluded: 0
		});
	});

	it('survives a structurally broken entry', () => {
		expect(mapItineraryToFlightOffer(null as unknown as KiwiPublicItinerary)).toBeUndefined();
		expect(mapItineraryToFlightOffer({})).toBeUndefined();
	});
});

describe('mapOnePerCityResultToDestinations', () => {
	it('lists the airports Boa Vista actually flies to directly', () => {
		const destinations = mapOnePerCityResultToDestinations(
			onePerCityBvc.data.onewayOnePerCityItineraries
		);

		// The line the whole search was dying on: Ryanair 404s BVC and the build-time
		// Travelpayouts dataset held one route for it, so the connection graph had nothing
		// to rank. LGW being in here is what lets it propose the owner's own stopover.
		expect(destinations).toContain('LGW');
		expect(destinations).toContain('LIS');
		expect(destinations.length).toBeGreaterThan(5);
	});

	it('lists Pafos among Gatwick direct destinations, completing the reference route', () => {
		const destinations = mapOnePerCityResultToDestinations(
			onePerCityLgw.data.onewayOnePerCityItineraries
		);

		expect(destinations).toContain('PFO');
	});

	it('de-duplicates repeated destination codes', () => {
		const destinations = mapOnePerCityResultToDestinations({
			__typename: 'OnePerCityItineraries',
			itineraries: [
				{ destination: { station: { code: 'LGW', type: 'AIRPORT' } } },
				{ destination: { station: { code: 'LGW', type: 'AIRPORT' } } }
			]
		});

		expect(destinations).toEqual(['LGW']);
	});

	it('skips stations that are not airports', () => {
		// Issue #89: a non-airport code reaching the connection graph costs a real request
		// per candidate before anything downstream notices it is not queryable.
		const destinations = mapOnePerCityResultToDestinations({
			__typename: 'OnePerCityItineraries',
			itineraries: [
				{ destination: { station: { code: 'LGW', type: 'AIRPORT' } } },
				{ destination: { station: { code: 'XVK', type: 'BUS_STATION' } } }
			]
		});

		expect(destinations).toEqual(['LGW']);
	});

	it('returns an empty list for an unknown airport rather than throwing', () => {
		expect(
			mapOnePerCityResultToDestinations({ __typename: 'OnePerCityItineraries', itineraries: [] })
		).toEqual([]);
		expect(mapOnePerCityResultToDestinations(undefined)).toEqual([]);
	});
});

describe('appErrorOf', () => {
	it("reads Kiwi's own message so it can be shown verbatim", () => {
		expect(appErrorOf({ __typename: 'AppError', error: 'Something went wrong' })).toBe(
			'Something went wrong'
		);
	});

	it('reports no error for a successful result', () => {
		expect(appErrorOf({ __typename: 'Itineraries', itineraries: [] })).toBeUndefined();
		expect(appErrorOf(undefined)).toBeUndefined();
	});
});

describe('buildKiwiDeepLink', () => {
	it('builds the pre-filled Kiwi search page for this route and date', () => {
		expect(buildKiwiDeepLink('BVC', 'LGW', '2026-10-06')).toBe(
			'https://www.kiwi.com/en/search/results/BVC/LGW/2026-10-06'
		);
	});
});
