import { describe, expect, it } from 'vitest';
import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Stay, Transfer } from '$lib/domain';
import { buildItineraryMapModel } from './segments';
import { buildFlightShape, buildGroundLegPreviews } from './previews';

// Same fixture shape as segments.test.ts, kept local so a change to that file's builders
// cannot silently move this file's assertions.

function localDateTime(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

const originAirport: Airport = {
	iataCode: 'MAD',
	name: 'Adolfo Suárez Madrid–Barajas',
	coordinates: { latitude: 40.4936, longitude: -3.5668 },
	city: {
		name: 'Madrid',
		coordinates: { latitude: 40.4168, longitude: -3.7038 },
		country: { isoCode: 'ES', name: 'Spain' }
	},
	country: { isoCode: 'ES', name: 'Spain' },
	sizeClass: 'large'
};

const connectionAirport: Airport = {
	iataCode: 'VIE',
	name: 'Vienna International Airport',
	coordinates: { latitude: 48.1103, longitude: 16.5697 },
	city: {
		name: 'Vienna',
		coordinates: { latitude: 48.2082, longitude: 16.3738 },
		country: { isoCode: 'AT', name: 'Austria' }
	},
	country: { isoCode: 'AT', name: 'Austria' },
	sizeClass: 'large'
};

const destinationAirport: Airport = {
	iataCode: 'TLL',
	name: 'Tallinn Airport',
	coordinates: { latitude: 59.4133, longitude: 24.8328 },
	city: {
		name: 'Tallinn',
		coordinates: { latitude: 59.437, longitude: 24.7536 },
		country: { isoCode: 'EE', name: 'Estonia' }
	},
	country: { isoCode: 'EE', name: 'Estonia' },
	sizeClass: 'medium'
};

function flight(departureAirport: string, arrivalAirport: string, flightNumber: string): FlightOffer {
	return {
		carrier: { iataCode: 'AB', name: 'Air Baseline' },
		flightNumber,
		departureAirport,
		arrivalAirport,
		departure: localDateTime('2026-09-10T08:00:00'),
		arrival: localDateTime('2026-09-10T10:30:00'),
		duration: 150 as Duration,
		price: { minorUnits: 8000, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid/book'
	};
}

function transfer(path?: Transfer['path']): Transfer {
	return { mode: 'walk', duration: 15 as Duration, legs: [], path };
}

const stay: Stay = {
	property: { name: 'Test Hostel', coordinates: { latitude: 48.2082, longitude: 16.3738 }, images: [] },
	roomKind: 'private',
	pricePerNight: { minorUnits: 4000, currency: 'EUR' }
};

function baseItinerary(): Itinerary {
	return {
		originAirport,
		originWaitingTime: 120 as Duration,
		outboundFlight: flight('MAD', 'VIE', 'AB100'),
		transferToHotel: transfer(),
		stay,
		freeTime: {
			start: localDateTime('2026-09-10T11:00:00'),
			end: localDateTime('2026-09-10T13:00:00'),
			duration: 120 as Duration
		},
		nightsInConnection: 0,
		transferToConnectionAirport: transfer(),
		connectionWaitingTime: 120 as Duration,
		onwardFlight: flight('VIE', 'TLL', 'AB200'),
		destinationAirport,
		totalPrice: { minorUnits: 20000, currency: 'EUR' },
		travellers: 1,
		times: {
			inFlight: 300 as Duration,
			airportWaiting: 240 as Duration,
			connectionAirportWaiting: 120 as Duration,
			free: 120 as Duration,
			total: 690 as Duration
		}
	};
}

function withBothEnds(): Itinerary {
	return {
		...baseItinerary(),
		originLocation: { label: 'Home', coordinates: { latitude: 40.4168, longitude: -3.7038 } },
		transferToOriginAirport: transfer(),
		destinationLocation: { label: 'Old town flat', coordinates: { latitude: 59.437, longitude: 24.7536 } },
		transferToDestinationLocation: transfer()
	};
}

const model = (itinerary: Itinerary) => buildItineraryMapModel(itinerary, connectionAirport);

describe('buildGroundLegPreviews', () => {
	it('gives all three previews when every leg exists, in journey order', () => {
		const previews = buildGroundLegPreviews(model(withBothEnds()));

		expect(previews.map((p) => p.id)).toEqual([
			'origin-transport',
			'stopover-transport',
			'destination-transport'
		]);
		expect(previews.map((p) => p.label)).toEqual(['To the airport', 'The stopover', 'To the destination']);
	});

	it('drops the origin preview when no origin location was set, leaving two', () => {
		const itinerary = withBothEnds();
		delete itinerary.originLocation;
		delete itinerary.transferToOriginAirport;

		const previews = buildGroundLegPreviews(model(itinerary));

		expect(previews.map((p) => p.id)).toEqual(['stopover-transport', 'destination-transport']);
	});

	it('drops the destination preview when no destination location was set', () => {
		const itinerary = withBothEnds();
		delete itinerary.destinationLocation;
		delete itinerary.transferToDestinationLocation;

		expect(buildGroundLegPreviews(model(itinerary)).map((p) => p.id)).toEqual([
			'origin-transport',
			'stopover-transport'
		]);
	});

	it('draws the stopover preview from both in-city legs at once', () => {
		const [stopover] = buildGroundLegPreviews(model(baseItinerary()));

		expect(stopover.id).toBe('stopover-transport');
		expect(stopover.lines).toHaveLength(2);
		// Airport, hotel: four endpoints across two legs, deduplicated to the two places.
		expect(stopover.points).toHaveLength(2);
	});

	it('opens the dialog on the first segment the preview actually draws', () => {
		const previews = buildGroundLegPreviews(model(withBothEnds()));

		expect(previews.map((p) => p.focusSegmentId)).toEqual([
			'transfer-to-origin-airport',
			'transfer-to-hotel',
			'transfer-to-destination-location'
		]);
	});

	it('carries the segments own wording, straight-line caveat included', () => {
		const [origin] = buildGroundLegPreviews(model(withBothEnds()));

		// The transfer has no `path`, so the map calls it an estimate and the preview must
		// not launder that away.
		expect(origin.title).toBe('Transfer to MAD (straight-line estimate)');
		expect(origin.lines[0].geometryKind).toBe('schematic');
	});

	it('marks a leg real once a provider route came through', () => {
		const itinerary = withBothEnds();
		itinerary.transferToOriginAirport = transfer([
			{ latitude: 40.4168, longitude: -3.7038 },
			{ latitude: 40.45, longitude: -3.65 },
			{ latitude: 40.4936, longitude: -3.5668 }
		]);

		const [origin] = buildGroundLegPreviews(model(itinerary));

		expect(origin.lines[0].geometryKind).toBe('real');
		expect(origin.title).toBe('Transfer to MAD');
	});

	it('returns nothing when the itinerary has no ground legs at all', () => {
		const itinerary = baseItinerary();
		delete itinerary.transferToHotel;
		delete itinerary.transferToConnectionAirport;

		expect(buildGroundLegPreviews(model(itinerary))).toEqual([]);
	});
});

describe('buildFlightShape', () => {
	it('draws both flown legs plus the direct line that is not one of them', () => {
		const shape = buildFlightShape(model(baseItinerary()));

		expect(shape).toBeDefined();
		expect(shape!.lines).toHaveLength(2);
		expect(shape!.directLine.length).toBeGreaterThan(2);
	});

	it('starts and ends the direct line at the two end airports, never at the connection', () => {
		const shape = buildFlightShape(model(baseItinerary()))!;
		const first = shape.directLine[0];
		const last = shape.directLine[shape.directLine.length - 1];

		expect(first.latitude).toBeCloseTo(originAirport.coordinates.latitude, 6);
		expect(first.longitude).toBeCloseTo(originAirport.coordinates.longitude, 6);
		expect(last.latitude).toBeCloseTo(destinationAirport.coordinates.latitude, 6);
		expect(last.longitude).toBeCloseTo(destinationAirport.coordinates.longitude, 6);
	});

	it('measures the detour Madrid to Tallinn via Vienna costs', () => {
		const shape = buildFlightShape(model(baseItinerary()))!;

		// Madrid to Tallinn direct is about 2880 km. Vienna sits close to that line, so the
		// two legs add up to roughly 3170 and the connection costs about 290 km of extra
		// flying. This is the "nearly straight" case the ornament exists to show.
		expect(shape.directKm).toBeGreaterThan(2800);
		expect(shape.directKm).toBeLessThan(2950);
		expect(shape.extraKm).toBeGreaterThan(200);
		expect(shape.extraKm).toBeLessThan(400);
		expect(shape.flownKm).toBeGreaterThan(shape.directKm);
		expect(shape.extraKm).toBeCloseTo(shape.flownKm - shape.directKm, 6);
	});

	it('never reports a negative detour, because a two-leg path cannot be shorter', () => {
		const itinerary = baseItinerary();
		// A connection sitting exactly on the direct path: flown and direct agree, and
		// floating-point noise must not print as "-0 km further".
		itinerary.onwardFlight = flight('VIE', 'MAD', 'AB300');
		const straight = buildFlightShape(
			buildItineraryMapModel({ ...itinerary, destinationAirport: originAirport }, connectionAirport)
		)!;

		expect(straight.extraKm).toBeGreaterThanOrEqual(0);
	});

	it('marks the connection airport as the stopover, and the two ends as neutral', () => {
		const shape = buildFlightShape(model(baseItinerary()))!;

		expect(shape.points.map((p) => p.tone)).toEqual(['neutral', 'stopover', 'neutral']);
	});
});
