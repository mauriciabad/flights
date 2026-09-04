import { describe, expect, it } from 'vitest';
import activeAirportsFixture from './fixtures/active-airports.json';
import cheapestPerDayFixture from './fixtures/cheapest-per-day-bcn-stn.json';
import scheduleFixture from './fixtures/schedule-bcn-stn.json';
import {
	buildNetworkSnapshot,
	buildScheduleIndex,
	carrierFor,
	mapDailyFareToFlightOffer,
	mapDailyFaresToFlightOffers
} from './ryanair-mapper';
import type {
	RyanairActiveAirportsResponse,
	RyanairCheapestPerDayResponse,
	RyanairMonthlyScheduleResponse
} from './ryanair-types';

const FETCHED_AT = '2026-09-04T10:00:00.000Z';
const snapshot = buildNetworkSnapshot(activeAirportsFixture as RyanairActiveAirportsResponse, FETCHED_AT);
const timeZones = snapshot.timeZonesByIataCode;
const fares = cheapestPerDayFixture as RyanairCheapestPerDayResponse;
const schedule = scheduleFixture as RyanairMonthlyScheduleResponse;
const scheduleIndex = buildScheduleIndex(schedule, 2026, 10);

/** The whole captured window. Individual tests narrow it to prove the clipping. */
const context = {
	origin: 'BCN',
	destination: 'STN',
	timeZoneByIataCode: timeZones,
	earliestDeparture: '2026-10-01',
	latestDeparture: '2026-10-31'
};

describe('buildNetworkSnapshot', () => {
	it('projects the active-airports fixture down to iataCode -> timeZone', () => {
		expect(timeZones).toEqual({
			BCN: 'Europe/Madrid',
			STN: 'Europe/London',
			AHO: 'Europe/Rome',
			BHX: 'Europe/London'
		});
	});

	it('keeps only the `airport:` entries of each route list', () => {
		// The fixture's BCN entry also carries `city:TALLINN`, `country:it` and
		// `region:ENGLAND`, which are search-widget facets, not routes to one airport.
		expect(snapshot.destinationsByOrigin.BCN.sort()).toEqual(['AHO', 'BHX', 'STN']);
		expect(snapshot.destinationsByOrigin.BHX).toEqual(['BCN']);
	});

	/**
	 * Issue #124: confirmed live that a different provider (Transitous, feeding
	 * flights-sky.ts/skyscanner.ts through airport-timezone.ts) can answer with a string
	 * that looks like a time zone but is not one — `"tz":"IANA"` for a real airport, not an
	 * actual zone name — and that reached `Intl.DateTimeFormat` unvalidated and threw an
	 * uncaught `RangeError`. Ryanair's own `/airports/en/active` feed is the same shape of
	 * risk (a provider-supplied string, not a value this app controls), so this proves the
	 * same guard applies here: an unusable value is dropped, not trusted through to a
	 * caller that will hand it to `Intl` three frames later.
	 */
	it('drops a time zone Intl cannot use, rather than trusting an unvalidated provider string', () => {
		const withBadZone = buildNetworkSnapshot(
			[{ iataCode: 'ZZZ', timeZone: 'IANA', routes: [] }] as unknown as RyanairActiveAirportsResponse,
			FETCHED_AT
		);
		expect(withBadZone.timeZonesByIataCode).toEqual({});
	});

	it('records an airport that flies nowhere as an empty list, not a missing key', () => {
		const grounded = buildNetworkSnapshot(
			[{ iataCode: 'XXX', timeZone: 'Europe/Madrid', routes: ['city:NOWHERE'] }] as RyanairActiveAirportsResponse,
			FETCHED_AT
		);
		expect(grounded.destinationsByOrigin).toEqual({ XXX: [] });
	});

	it('de-duplicates a destination listed in both routes and seasonalRoutes', () => {
		const duplicated = buildNetworkSnapshot(
			[
				{
					iataCode: 'BCN',
					timeZone: 'Europe/Madrid',
					routes: ['airport:STN', 'airport:AHO'],
					seasonalRoutes: ['airport:STN']
				}
			] as RyanairActiveAirportsResponse,
			FETCHED_AT
		);
		expect(duplicated.destinationsByOrigin.BCN).toEqual(['STN', 'AHO']);
	});

	it('drops the marketing-carrier suffix Ryanair appends to a codeshared leg', () => {
		// Real, and the only two in the whole feed on 2026-09-04: MLA and PMO list each
		// other as `airport:PMO|Air Malta` alongside a plain `airport:PMO`. Without the
		// split, "PMO|Air Malta" becomes a destination no fare provider can be asked about.
		const malta = buildNetworkSnapshot(
			[
				{
					iataCode: 'MLA',
					timeZone: 'Europe/Malta',
					routes: ['airport:PMO', 'airport:PMO|Air Malta', 'airport:STN']
				}
			] as RyanairActiveAirportsResponse,
			FETCHED_AT
		);
		expect(malta.destinationsByOrigin.MLA).toEqual(['PMO', 'STN']);
	});

	it('carries the fetch time through, since a snapshot that cannot date itself cannot be compared', () => {
		expect(snapshot.fetchedAt).toBe(FETCHED_AT);
	});
});

describe('buildScheduleIndex', () => {
	it('keys every scheduled flight by its own full date and departure minute', () => {
		expect(scheduleIndex.get('2026-10-01T15:45')).toMatchObject({ carrierCode: 'FR', number: '8215' });
		expect(scheduleIndex.get('2026-10-03T22:55')).toMatchObject({ carrierCode: 'FR', number: '9811' });
	});

	// The feed gives a bare day-of-month integer. Keying on that alone would let October's
	// fares resolve against November's timetable and come back with a real-looking flight
	// number for a flight that does not operate that day.
	it('cannot match a day from a different month', () => {
		const novemberIndex = buildScheduleIndex(schedule, 2026, 11);
		expect(novemberIndex.get('2026-10-01T15:45')).toBeUndefined();
		expect(novemberIndex.get('2026-11-01T15:45')).toBeDefined();
	});

	it('returns an empty index for the empty timetable an unflown route answers with', () => {
		expect(buildScheduleIndex({ month: 10, days: [] }, 2026, 10).size).toBe(0);
	});

	it('skips a structurally broken day or flight rather than throwing', () => {
		const broken = {
			month: 10,
			days: [
				{ day: 'first', flights: [] },
				{ day: 2, flights: null },
				{ day: 3, flights: [{ carrierCode: 'FR', departureTime: '10:00' }, { number: '1', departureTime: '11:00' }] },
				{ day: 4, flights: [{ carrierCode: 'FR', number: '900', departureTime: '12:00', arrivalTime: '13:00' }] }
			]
		} as unknown as RyanairMonthlyScheduleResponse;

		let index = new Map();
		expect(() => {
			index = buildScheduleIndex(broken, 2026, 10);
		}).not.toThrow();
		expect([...index.keys()]).toEqual(['2026-10-04T12:00']);
	});
});

describe('carrierFor', () => {
	it('names the Ryanair group carriers it knows', () => {
		expect(carrierFor('FR')).toEqual({ iataCode: 'FR', name: 'Ryanair' });
		expect(carrierFor('RK')).toEqual({ iataCode: 'RK', name: 'Ryanair UK' });
	});

	// Renaming an unknown code to "Ryanair" would put an airline's name on a flight this
	// table cannot vouch for. Keeping the code is less useful and more honest.
	it('keeps an unrecognised code as its own name rather than guessing', () => {
		expect(carrierFor('XX')).toEqual({ iataCode: 'XX', name: 'XX' });
	});
});

describe('mapDailyFareToFlightOffer', () => {
	it('maps a real captured BCN -> STN day to the exact domain shape, naming the flight from the timetable', () => {
		const offer = mapDailyFareToFlightOffer(fares.outbound.fares[0], scheduleIndex, context);

		expect(offer).toEqual({
			carrier: { iataCode: 'FR', name: 'Ryanair' },
			flightNumber: 'FR8215',
			departureAirport: 'BCN',
			arrivalAirport: 'STN',
			departure: { local: '2026-10-01T15:45:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
			arrival: { local: '2026-10-01T17:10:00', timeZone: 'Europe/London', utcOffsetMinutes: 60 },
			duration: 145,
			price: { minorUnits: 1499, currency: 'EUR' },
			priceScope: 'per-person',
			fareBrand: 'Basic',
			baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
			deepLink: expect.stringContaining('originIata=BCN')
		});
		expect(offer?.deepLink).toContain('destinationIata=STN');
		expect(offer?.deepLink).toContain('dateOut=2026-10-01');
	});

	// The 3 October fare leaves at 22:55 and lands after midnight. Both times stay as the
	// wall clock at their own airport, with their own offsets, so the overnight is visible
	// rather than normalised away (AGENTS.md "Timezones").
	it('keeps an overnight arrival on its real local date, not folded back into the departure day', () => {
		const offer = mapDailyFareToFlightOffer(fares.outbound.fares[2], scheduleIndex, context);
		expect(offer?.departure.local).toBe('2026-10-03T22:55:00');
		expect(offer?.arrival.local).toBe('2026-10-04T00:20:00');
		expect(offer?.flightNumber).toBe('FR9811');
		expect(offer?.duration).toBe(145);
	});

	// docs/ACCEPTANCE.md, "Never ship a flight that does not exist": measured 2026-09-04, a
	// route Ryanair does not fly answers 200 with a whole month of `unavailable` rows rather
	// than the 404 the routes endpoint gives. Mapping one would invent a flight outright.
	it('drops an unavailable day, which is how an unflown route answers', () => {
		const unavailable = {
			day: '2026-10-01',
			departureDate: null,
			arrivalDate: null,
			price: null,
			soldOut: false,
			unavailable: true
		};
		expect(mapDailyFareToFlightOffer(unavailable, scheduleIndex, context)).toBeUndefined();
	});

	it('drops a sold-out day, since its price cannot actually be bought', () => {
		const soldOut = structuredClone(fares.outbound.fares[0]);
		soldOut.soldOut = true;
		expect(mapDailyFareToFlightOffer(soldOut, scheduleIndex, context)).toBeUndefined();
	});

	// The fare feed names no flight. Without a timetable entry confirming a departure at
	// that exact minute, the only way to fill `flightNumber` would be to invent one, and
	// crosscheck.ts matches providers on it.
	it('drops a fare the timetable does not confirm rather than inventing a flight number', () => {
		const unscheduled = structuredClone(fares.outbound.fares[0]);
		unscheduled.departureDate = '2026-10-01T03:00:00';
		unscheduled.arrivalDate = '2026-10-01T04:25:00';
		expect(mapDailyFareToFlightOffer(unscheduled, scheduleIndex, context)).toBeUndefined();
	});

	it('drops a day outside the window the traveller asked about', () => {
		const narrow = { ...context, earliestDeparture: '2026-10-02', latestDeparture: '2026-10-02' };
		expect(mapDailyFareToFlightOffer(fares.outbound.fares[0], scheduleIndex, narrow)).toBeUndefined();
		expect(mapDailyFareToFlightOffer(fares.outbound.fares[1], scheduleIndex, narrow)).toBeDefined();
	});

	it('returns undefined rather than guessing when an airport has no known timezone', () => {
		const unknownZone = { ...context, destination: 'ZZZ' };
		expect(mapDailyFareToFlightOffer(fares.outbound.fares[0], scheduleIndex, unknownZone)).toBeUndefined();
	});

	it('carries the currency the response actually returned, not an assumed one', () => {
		const gbp = structuredClone(fares.outbound.fares[0]);
		gbp.price = {
			value: 12.34,
			valueMainUnit: '12',
			valueFractionalUnit: '34',
			currencyCode: 'GBP',
			currencySymbol: '£'
		};
		expect(mapDailyFareToFlightOffer(gbp, scheduleIndex, context)?.price).toEqual({
			minorUnits: 1234,
			currency: 'GBP'
		});
	});

	// Issue #93: `valueMainUnit` renamed, retyped, or otherwise missing used to reach
	// `Number.parseInt` unchecked and come back `NaN` — a number, so nothing downstream
	// noticed a price had stopped being a real one. Every case below must drop the fare.
	it('drops a fare whose price.valueMainUnit is missing rather than reporting NaN', () => {
		const corrupted = structuredClone(fares.outbound.fares[0]);
		// @ts-expect-error deliberately corrupting a required field to simulate schema drift.
		delete corrupted.price.valueMainUnit;
		expect(mapDailyFareToFlightOffer(corrupted, scheduleIndex, context)).toBeUndefined();
	});

	it('drops a fare whose price.valueMainUnit was retyped to a number', () => {
		const corrupted = structuredClone(fares.outbound.fares[0]);
		// @ts-expect-error deliberately corrupting a required field to simulate schema drift.
		corrupted.price.valueMainUnit = 14;
		expect(mapDailyFareToFlightOffer(corrupted, scheduleIndex, context)).toBeUndefined();
	});

	it('drops a fare whose price.valueFractionalUnit was retyped to null', () => {
		const corrupted = structuredClone(fares.outbound.fares[0]);
		// @ts-expect-error deliberately corrupting a required field to simulate schema drift.
		corrupted.price.valueFractionalUnit = null;
		expect(mapDailyFareToFlightOffer(corrupted, scheduleIndex, context)).toBeUndefined();
	});

	it('drops a fare whose price is missing entirely', () => {
		const corrupted = structuredClone(fares.outbound.fares[0]);
		corrupted.price = null;
		expect(mapDailyFareToFlightOffer(corrupted, scheduleIndex, context)).toBeUndefined();
	});

	it('drops a fare whose departureDate is not a parsable ISO string, instead of throwing', () => {
		const corrupted = structuredClone(fares.outbound.fares[0]);
		corrupted.departureDate = 'not-a-date';
		expect(() => mapDailyFareToFlightOffer(corrupted, scheduleIndex, context)).not.toThrow();
		expect(mapDailyFareToFlightOffer(corrupted, scheduleIndex, context)).toBeUndefined();
	});

	it('drops a fare whose arrivalDate is null, instead of throwing', () => {
		const corrupted = structuredClone(fares.outbound.fares[0]);
		corrupted.arrivalDate = null;
		expect(() => mapDailyFareToFlightOffer(corrupted, scheduleIndex, context)).not.toThrow();
		expect(mapDailyFareToFlightOffer(corrupted, scheduleIndex, context)).toBeUndefined();
	});

	it('drops a fare that is not an object at all, instead of throwing', () => {
		// @ts-expect-error deliberately passing a structurally broken fare entry.
		expect(() => mapDailyFareToFlightOffer(null, scheduleIndex, context)).not.toThrow();
		// @ts-expect-error deliberately passing a structurally broken fare entry.
		expect(mapDailyFareToFlightOffer(null, scheduleIndex, context)).toBeUndefined();
	});
});

describe('mapDailyFaresToFlightOffers', () => {
	// The whole point of issue #137: one request now yields a row per sellable day, so the
	// picker has real dates to offer instead of the single fare the fare finder returned.
	it('maps every sellable day in the captured month to its own offer', () => {
		const offers = mapDailyFaresToFlightOffers(fares, scheduleIndex, context);

		expect(offers).toHaveLength(6);
		expect(offers.map((offer) => offer.departure.local.slice(0, 10))).toEqual([
			'2026-10-01',
			'2026-10-02',
			'2026-10-03',
			'2026-10-04',
			'2026-10-05',
			'2026-10-06'
		]);
		expect(offers.map((offer) => offer.flightNumber)).toEqual([
			'FR8215',
			'FR8215',
			'FR9811',
			'FR8231',
			'FR8231',
			'FR8215'
		]);
		expect(new Set(offers.map((offer) => offer.price.minorUnits)).size).toBeGreaterThan(1);
		expect(offers.every((offer) => Number.isFinite(offer.price.minorUnits))).toBe(true);
		expect(offers.every((offer) => offer.priceScope === 'per-person')).toBe(true);
	});

	it('clips to the traveller’s window rather than returning the whole calendar month', () => {
		const offers = mapDailyFaresToFlightOffers(fares, scheduleIndex, {
			...context,
			earliestDeparture: '2026-10-02',
			latestDeparture: '2026-10-04'
		});
		expect(offers.map((offer) => offer.departure.local.slice(0, 10))).toEqual([
			'2026-10-02',
			'2026-10-03',
			'2026-10-04'
		]);
	});

	it('returns nothing at all when the timetable is empty, never a nameless flight', () => {
		expect(mapDailyFaresToFlightOffers(fares, new Map(), context)).toEqual([]);
	});

	it('drops one malformed day among otherwise good ones rather than failing the batch', () => {
		const drifted = structuredClone(fares);
		// @ts-expect-error deliberately corrupting a required field to simulate schema drift.
		drifted.outbound.fares[0].price.valueMainUnit = undefined;

		const offers = mapDailyFaresToFlightOffers(drifted, scheduleIndex, context);
		expect(offers).toHaveLength(5);
		expect(offers[0]?.departure.local.slice(0, 10)).toBe('2026-10-02');
	});

	it('returns an empty list, not a throw, for a body with no fares array', () => {
		const broken = { outbound: {} } as unknown as RyanairCheapestPerDayResponse;
		expect(() => mapDailyFaresToFlightOffers(broken, scheduleIndex, context)).not.toThrow();
		expect(mapDailyFaresToFlightOffers(broken, scheduleIndex, context)).toEqual([]);
	});
});

