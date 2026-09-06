import { describe, expect, it } from 'vitest';
import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Stay, Transfer } from '$lib/domain';
import { allCoordinates, buildItineraryMapModel, findSegment, groundLegSteps } from './segments';
import { itineraryMapStatus } from './status';
import type { ItinerarySegmentId } from './segment-id';
import { unroutedLegNote } from '$lib/components/itinerary-timeline-format';
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
			connectionAirportWaiting: 120 as Duration,
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

	/** The eleven airports issue #162 keeps a hand-checked centre for are the exception,
	 *  not the rule: everywhere else `City.coordinates` is `undefined` and the connection
	 *  city has no point of its own at all. */
	const connectionAirportWithoutCityPoint: Airport = {
		...connectionAirport,
		city: { ...connectionAirport.city, coordinates: undefined }
	};

	it('drops the two in-city transfer segments when nothing routed, and stands the stopover on the city centre', () => {
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
			label: 'Stopover in Vienna',
			// Issue #162's hand-checked city point, when the airport has one.
			coordinates: connectionAirport.city.coordinates,
			// Issue #141: a city centre is a real point and still not an address, so the
			// camera frames the city rather than zooming to a street corner nobody named.
			precision: 'city'
		});
	});

	it('falls back to the runway when the connection city has no checked point, and says it is still a city', () => {
		const model = buildItineraryMapModel(itineraryWithoutStay(), connectionAirportWithoutCityPoint);

		const freeTime = findSegment(model, 'free-time');
		expect(freeTime?.kind === 'point' && freeTime.coordinates).toEqual(connectionAirport.coordinates);
		expect(freeTime?.kind === 'point' && freeTime.precision).toBe('city');
	});

	// Issue #161, merged while this was in flight: with no bed priced the two in-city legs
	// route to the connection city's centre instead, so a transfer can exist with no stay.
	// Calling those legs absent because no bed was priced would assert a cause the
	// itinerary itself contradicts.
	it('draws a leg that goes into town even though no bed was priced', () => {
		const itinerary: Itinerary = {
			...itineraryWithoutStay(),
			transferToHotel: transfer(),
			transferToConnectionAirport: transfer()
		};
		const model = buildItineraryMapModel(itinerary, connectionAirport);

		const intoTown = findSegment(model, 'transfer-to-hotel');
		expect(intoTown?.kind === 'line' && intoTown.label).toBe('Transfer to Vienna (straight-line estimate)');
		expect(intoTown?.kind === 'line' && intoTown.coordinates).toEqual([
			connectionAirport.coordinates,
			connectionAirport.city.coordinates
		]);
		expect(findSegment(model, 'transfer-to-connection-airport')).toBeDefined();
		expect(model.absentSegmentNotes).toEqual({});
	});

	it('will not draw a leg into a city it has no point for, and explains that instead', () => {
		const itinerary: Itinerary = {
			...itineraryWithoutStay(),
			transferToHotel: transfer(),
			transferToConnectionAirport: transfer()
		};
		const model = buildItineraryMapModel(itinerary, connectionAirportWithoutCityPoint);

		expect(findSegment(model, 'transfer-to-hotel')).toBeUndefined();
		expect(model.absentSegmentNotes['transfer-to-hotel']).toContain('Nothing to draw.');
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

describe('absentSegmentNotes (issue #141: a selected step the map cannot draw)', () => {
	/** Every id `ItineraryTimeline` renders a selectable row for, given an itinerary with
	 *  an origin and a destination location. `ITINERARY_SEGMENT_ORDER` is the same list;
	 *  it is spelled out here so a future id added to that constant fails this test rather
	 *  than silently joining the set of steps the map can go quiet on. */
	const SELECTABLE_IDS: ItinerarySegmentId[] = [
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
	];

	function fullItinerary(overrides: Partial<Itinerary> = {}): Itinerary {
		return {
			...baseItinerary(),
			originLocation: { label: 'Home', coordinates: { latitude: 40.42, longitude: -3.7 } },
			transferToOriginAirport: transfer(),
			destinationLocation: { label: 'Office', coordinates: { latitude: 59.44, longitude: 24.75 } },
			transferToDestinationLocation: transfer(),
			...overrides
		};
	}

	it('leaves every drawable step unexplained, because it is drawn', () => {
		const model = buildItineraryMapModel(fullItinerary(), connectionAirport);

		expect(model.absentSegmentNotes).toEqual({});
		expect(model.segments.map((s) => s.id).sort()).toEqual([...SELECTABLE_IDS].sort());
	});

	it('explains every step it cannot draw, so no selection is ever answered with silence', () => {
		const model = buildItineraryMapModel(
			fullItinerary({
				stay: undefined,
				transferToHotel: undefined,
				transferToConnectionAirport: undefined,
				transferToOriginAirport: undefined,
				transferToDestinationLocation: undefined,
				nightsInConnection: 2
			}),
			connectionAirport
		);

		const drawn = new Set(model.segments.map((s) => s.id));
		for (const id of SELECTABLE_IDS) {
			const explained = model.absentSegmentNotes[id];
			expect(drawn.has(id) || typeof explained === 'string', `${id} is neither drawn nor explained`).toBe(true);
		}
	});

	it('names the missing bed from both ends of the stopover, and the same-day case apart', () => {
		const nights = buildItineraryMapModel(
			fullItinerary({
				stay: undefined,
				transferToHotel: undefined,
				transferToConnectionAirport: undefined,
				nightsInConnection: 2
			}),
			connectionAirport
		);
		// The reason half is `unroutedLegNote`'s own sentence, the one the timeline row the
		// traveller just clicked is already showing. Asserted through that function rather
		// than as a literal, so a reword there moves both together instead of failing here.
		expect(nights.absentSegmentNotes['transfer-to-hotel']).toBe(
			`Nothing to draw. ${unroutedLegNote('to-hotel', { hasStay: false, nightsInConnection: 2 })}`
		);
		expect(nights.absentSegmentNotes['transfer-to-connection-airport']).toBe(
			`Nothing to draw. ${unroutedLegNote('from-hotel', { hasStay: false, nightsInConnection: 2 })}`
		);

		const sameDay = buildItineraryMapModel(
			fullItinerary({
				stay: undefined,
				transferToHotel: undefined,
				transferToConnectionAirport: undefined,
				nightsInConnection: 0
			}),
			connectionAirport
		);
		expect(sameDay.absentSegmentNotes['transfer-to-hotel']).toBe(
			'Nothing to draw. Same-day connection, so there is no hotel leg here.'
		);
	});

	it('blames the providers, not the missing bed, when a stay was priced but a leg was not routed', () => {
		const model = buildItineraryMapModel(
			// Two nights, because that is what issue #211's case actually is: a bed this trip
			// BOOKS, which no transfer provider could find a route to. Issue #365 gave the
			// nightless version of the same shape its own sentence, and a trip with no night
			// gets that one whether or not a bed was quoted, so a fixture at zero nights can
			// no longer stand in for this.
			fullItinerary({
				transferToHotel: undefined,
				transferToDestinationLocation: undefined,
				nightsInConnection: 2
			}),
			connectionAirport
		);

		// Issue #211 sharpened the hotel-bound wording. The point this test was written to
		// make is unchanged, and is the reason it exists: the note must not blame a missing
		// bed for a routing failure, because the bed is right there on the card with a price
		// on it. Naming the bed makes that clearer, not less true.
		expect(model.absentSegmentNotes['transfer-to-hotel']).toBe(
			'Nothing to draw. The bed is priced, but no transport provider could route to it.'
		);
		// The outer legs have no bed to speak of either way, so they keep the general
		// sentence.
		expect(model.absentSegmentNotes['transfer-to-destination-location']).toBe(
			'Nothing to draw. No route came back from the transport providers for this leg.'
		);
	});

	it('says nothing about a step the timeline never renders either', () => {
		// No origin location means no "travel to the origin airport" row anywhere, so an
		// explanation for it would be an answer to a question nobody can ask.
		const model = buildItineraryMapModel(baseItinerary(), connectionAirport);
		expect(model.absentSegmentNotes['transfer-to-origin-airport']).toBeUndefined();
		expect(model.absentSegmentNotes['transfer-to-destination-location']).toBeUndefined();
	});
});

describe('point precision (issue #141)', () => {
	it('calls the hotel an address and the bedless stopover a city', () => {
		const withStay = buildItineraryMapModel(baseItinerary(), connectionAirport);
		const freeTime = findSegment(withStay, 'free-time');
		expect(freeTime?.kind === 'point' && freeTime.precision).toBe('exact');

		const withoutStay = buildItineraryMapModel(
			{ ...baseItinerary(), stay: undefined, transferToHotel: undefined, transferToConnectionAirport: undefined },
			connectionAirport
		);
		const bedless = findSegment(withoutStay, 'free-time');
		expect(bedless?.kind === 'point' && bedless.precision).toBe('city');
	});

	it('treats every airport and typed-in location as an address', () => {
		const model = buildItineraryMapModel(
			{
				...baseItinerary(),
				originLocation: { label: 'Home', coordinates: { latitude: 40.42, longitude: -3.7 } },
				transferToOriginAirport: transfer(),
				destinationLocation: { label: 'Office', coordinates: { latitude: 59.44, longitude: 24.75 } },
				transferToDestinationLocation: transfer()
			},
			connectionAirport
		);

		const points = model.segments.filter((s) => s.kind === 'point');
		expect(points.filter((p) => p.precision !== 'exact').map((p) => p.id)).toEqual([]);
	});
});

describe('groundLegSteps (issue #286: reaching a leg the map cannot draw)', () => {
	function withBothEnds(overrides: Partial<Itinerary> = {}): Itinerary {
		return {
			...baseItinerary(),
			originLocation: { label: 'Home', coordinates: { latitude: 40.42, longitude: -3.7 } },
			transferToOriginAirport: transfer(),
			destinationLocation: { label: 'Office', coordinates: { latitude: 59.44, longitude: 24.75 } },
			transferToDestinationLocation: transfer(),
			...overrides
		};
	}

	it('lists every ground leg of the trip, in travel order', () => {
		const model = buildItineraryMapModel(withBothEnds(), connectionAirport);

		expect(groundLegSteps(model).map((step) => step.id)).toEqual([
			'transfer-to-origin-airport',
			'transfer-to-hotel',
			'transfer-to-connection-airport',
			'transfer-to-destination-location'
		]);
	});

	it('offers a leg nobody routed, which is the only way left to reach its note', () => {
		const model = buildItineraryMapModel(
			withBothEnds({
				stay: undefined,
				transferToHotel: undefined,
				transferToConnectionAirport: undefined,
				nightsInConnection: 2
			}),
			connectionAirport
		);

		const ids = groundLegSteps(model).map((step) => step.id);
		expect(ids).toContain('transfer-to-hotel');
		expect(findSegment(model, 'transfer-to-hotel')).toBeUndefined();
	});

	it('leaves out a leg the trip does not have, rather than offering a journey nobody is on', () => {
		const model = buildItineraryMapModel(baseItinerary(), connectionAirport);

		expect(groundLegSteps(model).map((step) => step.id)).toEqual([
			'transfer-to-hotel',
			'transfer-to-connection-airport'
		]);
	});

	// The load-bearing one. #141 made "every id is either drawn or explained" a property of
	// the model; this makes "every leg you can press answers with a sentence" a property of
	// the control, so a step added here without a note fails in vitest rather than in a
	// traveller's dialog.
	it('answers every leg it offers with a real sentence, drawn or not', () => {
		for (const itinerary of [
			withBothEnds(),
			withBothEnds({ stay: undefined, transferToHotel: undefined, transferToConnectionAirport: undefined, nightsInConnection: 2 }),
			withBothEnds({ transferToOriginAirport: undefined, transferToDestinationLocation: undefined })
		]) {
			const model = buildItineraryMapModel(itinerary, connectionAirport);
			for (const step of groundLegSteps(model)) {
				expect(itineraryMapStatus(model, step.id).text, `${step.id} answered with nothing`).not.toBe('');
			}
		}
	});
});
