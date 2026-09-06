import { describe, expect, it } from 'vitest';
import type {
	Airport,
	City,
	Country,
	Duration,
	FlightOffer,
	IataAirportCode,
	Itinerary,
	LocalDateTime,
	Money,
	Stay,
	Transfer
} from '../domain';
import type { ItineraryGroup, ItineraryResult } from '../search/types';
import { buildConnectionsMapModel, countByState } from './model';

const country: Country = { isoCode: 'AT', name: 'Austria' };

function makeAirport(iataCode: string, latitude: number, longitude: number, cityName = iataCode): Airport {
	const city: City = { name: cityName, coordinates: { latitude, longitude }, country };
	return { iataCode, name: `${iataCode} airport`, coordinates: { latitude, longitude }, city, country, sizeClass: 'medium' };
}

const LGW = makeAirport('LGW', 51.15, -0.19, 'London');
const VIE = makeAirport('VIE', 48.11, 16.57, 'Vienna');
const IST = makeAirport('IST', 41.26, 28.74, 'Istanbul');
const MXP = makeAirport('MXP', 45.63, 8.72, 'Milan');

function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 60 };
}

function makeFlight(from: string, to: string, departure: string, arrival: string): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Test Air' },
		flightNumber: 'FR1',
		departureAirport: from,
		arrivalAirport: to,
		departure: at(departure),
		arrival: at(arrival),
		priceScope: 'per-person',
		duration: 120 as Duration,
		price: { minorUnits: 5000, currency: 'EUR' },
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	};
}

interface ItineraryOverrides {
	nights?: number;
	stay?: Stay;
	transferToHotel?: Transfer;
	onwardDeparture?: string;
}

function makeItinerary(overrides: ItineraryOverrides = {}): Itinerary {
	const total: Money = { minorUnits: 12_000, currency: 'EUR' };
	return {
		originAirport: LGW,
		originWaitingTime: 0 as Duration,
		outboundFlight: makeFlight('LGW', 'VIE', '2027-03-08T08:00:00', '2027-03-08T10:00:00'),
		stay: overrides.stay,
		transferToHotel: overrides.transferToHotel,
		freeTime: { start: at('2027-03-08T10:00:00'), end: at('2027-03-09T10:00:00'), duration: 1440 as Duration },
		nightsInConnection: overrides.nights ?? 1,
		travellers: 1,
		connectionWaitingTime: 0 as Duration,
		onwardFlight: makeFlight('VIE', 'IST', overrides.onwardDeparture ?? '2027-03-09T12:00:00', '2027-03-09T15:00:00'),
		destinationAirport: IST,
		totalPrice: total,
		times: {
			inFlight: 240 as Duration,
			airportWaiting: 0 as Duration,
			connectionAirportWaiting: 0 as Duration,
			originAirportWaiting: 0 as Duration,
			free: 1440 as Duration,
			total: 1740 as Duration
		}
	};
}

function makeGroup(code: string, itinerary: Itinerary, variants = 1): ItineraryGroup {
	const result: ItineraryResult = {
		score: { itinerary, total: 1, breakdown: {} as never, avoidedAirlineFlightCount: 0 },
		sources: {} as never
	};
	return {
		connectionAirportCode: code as IataAirportCode,
		best: result,
		variants: Array.from({ length: variants }, () => result)
	};
}

const airports = { LGW, VIE, IST, MXP } as Partial<Record<IataAirportCode, Airport>>;

function base(overrides: Partial<Parameters<typeof buildConnectionsMapModel>[0]> = {}) {
	return buildConnectionsMapModel({
		originAirport: LGW,
		destinationAirport: IST,
		minLayoverTime: 90 as Duration,
		candidateCodes: ['VIE', 'MXP'] as IataAirportCode[],
		airports,
		groups: [],
		blocked: {},
		...overrides
	});
}

describe('buildConnectionsMapModel', () => {
	it('draws a baseline between the two ends that is nobody’s flight', () => {
		const model = base();

		expect(model.directLine.length).toBeGreaterThan(2);
		expect(model.directLine[0]).toEqual(LGW.coordinates);
		expect(model.directLine.at(-1)?.latitude).toBeCloseTo(IST.coordinates.latitude, 5);
		// London to Istanbul, great circle. Wrong by more than a few km would mean the
		// baseline the detour is measured against is wrong too.
		expect(model.directKm).toBeGreaterThan(2400);
		expect(model.directKm).toBeLessThan(2600);
	});

	it('keeps the candidate ranking the results list already uses', () => {
		const model = base({ candidateCodes: ['MXP', 'VIE'] as IataAirportCode[] });

		expect(model.connections.map((connection) => connection.airport.iataCode)).toEqual(['MXP', 'VIE']);
		expect(model.connections.map((connection) => connection.rank)).toEqual([1, 2]);
	});

	it('measures the detour against the direct line, never below zero', () => {
		// Vienna sits almost exactly on the London to Istanbul great circle, so it costs
		// about fourteen kilometres to stop there. Stockholm is a real detour. The gap
		// between the two numbers is the whole reason this figure is on the panel.
		const ARN = makeAirport('ARN', 59.65, 17.92, 'Stockholm');
		const model = base({
			candidateCodes: ['VIE', 'ARN'] as IataAirportCode[],
			airports: { ...airports, ARN }
		});
		const [vienna, stockholm] = model.connections;

		expect(vienna.extraKm).toBeLessThan(50);
		expect(stockholm.extraKm).toBeGreaterThan(800);
		for (const connection of model.connections) expect(connection.extraKm).toBeGreaterThanOrEqual(0);
	});

	it('calls a fully quoted pairing bookable', () => {
		const stay: Stay = {
			property: { name: 'Test Hostel', coordinates: VIE.coordinates, images: [] },
			roomKind: 'dorm',
			pricePerNight: { minorUnits: 3000, currency: 'EUR' }
		};
		const model = base({ groups: [makeGroup('VIE', makeItinerary({ stay }))] });
		const vienna = model.connections[0];

		expect(vienna.state).toBe('bookable');
		expect(vienna.state === 'bookable' && vienna.trip.flightTime).toBe(240);
		// 10:00 on the 8th to 12:00 on the 9th.
		expect(vienna.state === 'bookable' && vienna.trip.layover).toBe(1560);
	});

	it('calls a pairing part-priced when a night is spent with no bed priced', () => {
		const model = base({ groups: [makeGroup('VIE', makeItinerary({ nights: 2 }))] });
		const vienna = model.connections[0];

		expect(vienna.state).toBe('part-priced');
		expect(vienna.state === 'part-priced' && vienna.trip.unpriced.bed).toBe(true);
	});

	it('does not call a change of plane unpriced for having no bed', () => {
		const model = base({ groups: [makeGroup('VIE', makeItinerary({ nights: 0 }))] });

		expect(model.connections[0].state).toBe('bookable');
	});

	it('names a ground leg a router found and nobody priced', () => {
		const transferToHotel: Transfer = { mode: 'taxi', duration: 30 as Duration, legs: [] };
		const model = base({ groups: [makeGroup('VIE', makeItinerary({ nights: 0, transferToHotel }))] });
		const vienna = model.connections[0];

		expect(vienna.state).toBe('part-priced');
		expect(vienna.state === 'part-priced' && vienna.trip.unpriced.transferLegs).toEqual(['transferToHotel']);
	});

	it('counts the OTHER pairings, not every pairing', () => {
		const model = base({ groups: [makeGroup('VIE', makeItinerary({ nights: 0 }), 3)] });

		expect(model.connections[0].state === 'bookable' && model.connections[0].trip.otherPairings).toBe(2);
	});

	it('carries the refusal through for a connection with no pairing', () => {
		const model = base({ blocked: { MXP: { reason: 'no-onward-flight' } } });
		const milan = model.connections.find((connection) => connection.airport.iataCode === 'MXP');

		expect(milan?.state).toBe('blocked');
		expect(milan?.state === 'blocked' && milan.block).toEqual({ reason: 'no-onward-flight' });
	});

	it('keeps "not finished" apart from "nothing flies"', () => {
		const model = base();

		expect(model.connections.map((connection) => connection.state)).toEqual(['pending', 'pending']);
		expect(countByState(model)).toEqual({ bookable: 0, 'part-priced': 0, blocked: 0, pending: 2 });
	});

	it('leaves out a code no airport record could be found for, rather than placing it at zero', () => {
		const model = base({ candidateCodes: ['VIE', 'ZZZ'] as IataAirportCode[] });

		expect(model.connections.map((connection) => connection.airport.iataCode)).toEqual(['VIE']);
	});

	it('draws an antimeridian route in one longitude frame instead of the long way round', () => {
		const NRT = makeAirport('NRT', 35.76, 140.39, 'Tokyo');
		const LAX = makeAirport('LAX', 33.94, -118.4, 'Los Angeles');
		const ANC = makeAirport('ANC', 61.17, -150.0, 'Anchorage');
		const model = buildConnectionsMapModel({
			originAirport: NRT,
			destinationAirport: LAX,
			minLayoverTime: 90 as Duration,
			candidateCodes: ['ANC'] as IataAirportCode[],
			airports: { ANC } as Partial<Record<IataAirportCode, Airport>>,
			groups: [],
			blocked: {}
		});

		// Every longitude on the picture sits east of Tokyo's, past +180, rather than
		// jumping to -118 and drawing back across Europe.
		const longitudes = [...model.directLine, ...model.connections[0].arcs.flat()].map((point) => point.longitude);
		expect(Math.min(...longitudes)).toBeGreaterThan(139);
		expect(Math.max(...longitudes)).toBeLessThan(250);
	});
});
