import { describe, expect, it } from 'vitest';
import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Stay, Transfer } from '$lib/domain';
import { allCoordinates, buildItineraryMapModel, findSegment } from './segments';

// ---------------------------------------------------------------------------
// Fixture builders — enough of each domain type to be a valid Itinerary, no more.
// Mirrors src/lib/algorithm/score.test.ts's fixture style.
// ---------------------------------------------------------------------------

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
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid/book'
	};
}

function transfer(): Transfer {
	return { mode: 'walk', duration: 15 as Duration, legs: [] };
}

const stay: Stay = {
	property: {
		name: 'Test Hostel',
		coordinates: { latitude: 48.2082, longitude: 16.3738 },
		images: []
	},
	roomKind: 'private',
	pricePerNight: { minorUnits: 4000, currency: 'EUR' }
};

/** The minimum valid Itinerary: no origin/destination location, so no transfer to/from
 *  either end — just airport to airport. */
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
			free: 120 as Duration,
			total: 690 as Duration
		}
	};
}

describe('buildItineraryMapModel', () => {
	it('draws the required chain for a minimal itinerary (no origin/destination location)', () => {
		const model = buildItineraryMapModel(baseItinerary(), connectionAirport);

		expect(model.segments.map((s) => s.id)).toEqual([
			'origin-waiting',
			'outbound-flight',
			'transfer-to-hotel',
			'free-time',
			'transfer-to-connection-airport',
			'connection-waiting',
			'onward-flight'
		]);
		// The onward flight has to land somewhere even though there is no waiting-time
		// row for it to attach to.
		expect(model.extraWaypoints).toEqual([
			{
				coordinates: destinationAirport.coordinates,
				label: 'Tallinn (TLL)',
				tone: 'neutral'
			}
		]);
	});

	it('adds origin/destination location and their transfers when the itinerary has them', () => {
		const itinerary: Itinerary = {
			...baseItinerary(),
			originLocation: { label: 'Home', coordinates: { latitude: 40.42, longitude: -3.7 } },
			transferToOriginAirport: transfer(),
			destinationLocation: { label: 'Office', coordinates: { latitude: 59.44, longitude: 24.75 } },
			transferToDestinationLocation: transfer()
		};

		const model = buildItineraryMapModel(itinerary, connectionAirport);

		expect(model.segments.map((s) => s.id)).toEqual([
			'origin-location',
			'transfer-to-origin-airport',
			'origin-waiting',
			'outbound-flight',
			'transfer-to-hotel',
			'free-time',
			'transfer-to-connection-airport',
			'connection-waiting',
			'onward-flight',
			'transfer-to-destination-location',
			'destination-location'
		]);
	});

	it('marks the hotel and the connection city as the stopover, and nothing else', () => {
		const model = buildItineraryMapModel(baseItinerary(), connectionAirport);

		const stopoverIds = model.segments.filter((s) => s.tone === 'stopover').map((s) => s.id);
		expect(stopoverIds).toEqual([
			'transfer-to-hotel',
			'free-time',
			'transfer-to-connection-airport',
			'connection-waiting'
		]);
	});

	it('renders the flights as densified great-circle arcs, not two-point lines', () => {
		const model = buildItineraryMapModel(baseItinerary(), connectionAirport);

		const outbound = findSegment(model, 'outbound-flight');
		expect(outbound?.kind).toBe('line');
		if (outbound?.kind === 'line') {
			expect(outbound.coordinates.length).toBeGreaterThan(2);
			expect(outbound.coordinates[0]).toEqual(originAirport.coordinates);
			expect(outbound.coordinates.at(-1)).toEqual(connectionAirport.coordinates);
		}
	});

	it('renders a transfer as a plain two-point line (no route shape available)', () => {
		const model = buildItineraryMapModel(baseItinerary(), connectionAirport);

		const toHotel = findSegment(model, 'transfer-to-hotel');
		expect(toHotel).toEqual({
			kind: 'line',
			id: 'transfer-to-hotel',
			role: 'transfer',
			tone: 'stopover',
			label: 'Transfer to Test Hostel',
			coordinates: [connectionAirport.coordinates, stay.property.coordinates]
		});
	});
});

describe('buildItineraryMapModel: no stay priced (issue #94)', () => {
	function itineraryWithoutStay(): Itinerary {
		return { ...baseItinerary(), stay: undefined, transferToHotel: undefined, transferToConnectionAirport: undefined };
	}

	it('drops the two in-city transfer segments, keeping free-time as a point at the connection airport', () => {
		const model = buildItineraryMapModel(itineraryWithoutStay(), connectionAirport);

		expect(model.segments.map((s) => s.id)).toEqual([
			'origin-waiting',
			'outbound-flight',
			'free-time',
			'connection-waiting',
			'onward-flight'
		]);
		expect(findSegment(model, 'transfer-to-hotel')).toBeUndefined();
		expect(findSegment(model, 'transfer-to-connection-airport')).toBeUndefined();

		const freeTime = findSegment(model, 'free-time');
		expect(freeTime).toEqual({
			kind: 'point',
			id: 'free-time',
			tone: 'stopover',
			label: 'Stopover at Vienna',
			coordinates: connectionAirport.coordinates
		});
	});

	it('still marks the free-time point itself as the stopover tone', () => {
		const model = buildItineraryMapModel(itineraryWithoutStay(), connectionAirport);
		const stopoverIds = model.segments.filter((s) => s.tone === 'stopover').map((s) => s.id);
		expect(stopoverIds).toEqual(['free-time', 'connection-waiting']);
	});
});

describe('allCoordinates', () => {
	it('includes every segment coordinate plus the extra waypoints', () => {
		const model = buildItineraryMapModel(baseItinerary(), connectionAirport);
		const points = allCoordinates(model);

		expect(points).toContainEqual(originAirport.coordinates);
		expect(points).toContainEqual(stay.property.coordinates);
		expect(points).toContainEqual(destinationAirport.coordinates);
		// Both flight arcs contribute many more than one point each.
		expect(points.length).toBeGreaterThan(10);
	});
});
