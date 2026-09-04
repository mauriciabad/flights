import { describe, expect, it } from 'vitest';
import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Stay, Transfer } from '$lib/domain';
import { allCoordinates, buildItineraryMapModel, findSegment } from './segments';
import { boundsOfCoordinates } from './geo';

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
		priceScope: 'per-person',
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
				tone: 'neutral',
				markerKind: 'airport'
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
			geometryKind: 'schematic',
			label: 'Transfer to Test Hostel (straight-line estimate)',
			coordinates: [connectionAirport.coordinates, stay.property.coordinates]
		});
	});

	it('draws a transfer\'s real OSRM geometry when the Transfer carries a path (issue #118), clamped to the exact endpoints', () => {
		const path = [
			{ latitude: 48.109, longitude: 16.57 }, // OSRM's own nearest-road snap, not the airport's exact point
			{ latitude: 48.15, longitude: 16.5 },
			{ latitude: 48.207, longitude: 16.375 } // ditto for the hotel end
		];
		const itinerary: Itinerary = {
			...baseItinerary(),
			transferToHotel: { mode: 'walk', duration: 15 as Duration, legs: [], path }
		};

		const model = buildItineraryMapModel(itinerary, connectionAirport);
		const toHotel = findSegment(model, 'transfer-to-hotel');

		expect(toHotel?.kind).toBe('line');
		if (toHotel?.kind !== 'line') return;
		expect(toHotel.geometryKind).toBe('real');
		// Real, provider-fetched geometry, but the very first and last points are
		// replaced with the itinerary's own known coordinates rather than OSRM's
		// nearest-road snap, so the line touches the marker instead of stopping short.
		expect(toHotel.coordinates).toEqual([
			connectionAirport.coordinates,
			path[1],
			stay.property.coordinates
		]);
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
			markerKind: 'stay',
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

describe('markerKind (issue #118: start/hotel/end distinct from airports)', () => {
	it('gives the origin/hotel/destination points their own marker kind, distinct from every airport', () => {
		const itinerary: Itinerary = {
			...baseItinerary(),
			originLocation: { label: 'Home', coordinates: { latitude: 40.42, longitude: -3.7 } },
			transferToOriginAirport: transfer(),
			destinationLocation: { label: 'Office', coordinates: { latitude: 59.44, longitude: 24.75 } },
			transferToDestinationLocation: transfer()
		};

		const model = buildItineraryMapModel(itinerary, connectionAirport);
		const markerKindById = Object.fromEntries(
			model.segments.filter((s) => s.kind === 'point').map((s) => [s.id, s.markerKind])
		);

		expect(markerKindById).toEqual({
			'origin-location': 'start',
			'origin-waiting': 'airport',
			'free-time': 'stay',
			'connection-waiting': 'airport',
			'destination-location': 'end'
		});
		expect(model.extraWaypoints.every((w) => w.markerKind === 'airport')).toBe(true);
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

describe('buildItineraryMapModel: a route that crosses the antimeridian', () => {
	// Auckland to Honolulu to Los Angeles. The outbound flight leaves at +174.8 and
	// lands at -157.9, which is 27 degrees away going east and 332 going west, and every
	// renderer takes the second reading unless the coordinates say otherwise.
	const auckland: Airport = {
		iataCode: 'AKL',
		name: 'Auckland Airport',
		coordinates: { latitude: -37.0082, longitude: 174.7917 },
		city: {
			name: 'Auckland',
			coordinates: { latitude: -36.8485, longitude: 174.7633 },
			country: { isoCode: 'NZ', name: 'New Zealand' }
		},
		country: { isoCode: 'NZ', name: 'New Zealand' },
		sizeClass: 'large'
	};
	const honolulu: Airport = {
		iataCode: 'HNL',
		name: 'Daniel K. Inouye International Airport',
		coordinates: { latitude: 21.3187, longitude: -157.9224 },
		city: {
			name: 'Honolulu',
			coordinates: { latitude: 21.3069, longitude: -157.8583 },
			country: { isoCode: 'US', name: 'United States' }
		},
		country: { isoCode: 'US', name: 'United States' },
		sizeClass: 'large'
	};
	const losAngeles: Airport = {
		iataCode: 'LAX',
		name: 'Los Angeles International Airport',
		coordinates: { latitude: 33.9416, longitude: -118.4085 },
		city: {
			name: 'Los Angeles',
			coordinates: { latitude: 34.0522, longitude: -118.2437 },
			country: { isoCode: 'US', name: 'United States' }
		},
		country: { isoCode: 'US', name: 'United States' },
		sizeClass: 'large'
	};

	function pacificItinerary(): Itinerary {
		return {
			...baseItinerary(),
			originAirport: auckland,
			outboundFlight: flight('AKL', 'HNL', 'AB300'),
			onwardFlight: flight('HNL', 'LAX', 'AB400'),
			destinationAirport: losAngeles,
			stay: {
				...stay,
				// Downtown Honolulu, the same point `honolulu.city.coordinates` carries above.
				// Written out rather than read off it because `City.coordinates` is optional
				// now (issue #162: most airports have no city point at all), and this fixture
				// needs a definite one.
				property: { ...stay.property, coordinates: { latitude: 21.3069, longitude: -157.8583 } }
			}
		};
	}

	it('keeps the whole chain in one frame, so nothing is drawn a world away from the leg it belongs to', () => {
		const model = buildItineraryMapModel(pacificItinerary(), honolulu);
		const points = allCoordinates(model);

		for (let i = 1; i < points.length; i++) {
			expect(
				Math.abs(points[i].longitude - points[i - 1].longitude),
				`points ${i - 1} and ${i} are on opposite sides of the map`
			).toBeLessThan(180);
		}
	});

	it('frames the trip rather than the globe', () => {
		const model = buildItineraryMapModel(pacificItinerary(), honolulu);
		const [west, , east] = boundsOfCoordinates(allCoordinates(model));

		// Auckland to Los Angeles is 67 degrees apart the short way. Before every
		// coordinate shared one frame this box came out at the full 360, and the camera
		// answered by showing the whole world with the route drawn back across it.
		expect(east - west).toBeLessThan(90);
	});

	it('ends the outbound arc exactly where the connection airport marker is drawn', () => {
		const model = buildItineraryMapModel(pacificItinerary(), honolulu);
		const outbound = findSegment(model, 'outbound-flight');
		const waiting = findSegment(model, 'connection-waiting');

		expect(outbound?.kind).toBe('line');
		expect(waiting?.kind).toBe('point');
		if (outbound?.kind === 'line' && waiting?.kind === 'point') {
			expect(outbound.coordinates.at(-1)).toEqual(waiting.coordinates);
			// The arc left Auckland heading east and crossed 180, so the whole trip is
			// drawn in the copy of the world east of it: Honolulu is 202.08, not its raw
			// -157.92, and Los Angeles follows at 241.6.
			expect(waiting.coordinates.longitude).toBeCloseTo(-157.9224 + 360, 4);
		}
	});
});
