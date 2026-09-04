import type { Airport, Coordinates, Itinerary } from '$lib/domain';
import { greatCircleArc } from './geo';
import type { ItinerarySegmentId } from './segment-id';

/**
 * Turns an `Itinerary` into the geometry `ItineraryMap` draws.
 *
 * `connectionAirport` is resolved by the caller rather than looked up in here:
 * `Itinerary` (`src/lib/domain/itinerary.ts`) never names the connection airport
 * directly, only `outboundFlight.arrivalAirport` and `onwardFlight.departureAirport`
 * carry its IATA code, so getting its coordinates means an async dataset lookup
 * (`src/lib/data/airports.ts`). Keeping that out of this module is what lets it stay a
 * plain synchronous function, testable with fixture data and no dataset load.
 */

/** The one thing this app is actually selling (AGENTS.md "Design": "the connection into
 *  a trip of its own") gets a colour nothing else on the map uses — the hotel and the
 *  connection city itself, never the origin/destination ends of the trip. */
export type ItinerarySegmentTone = 'neutral' | 'stopover';

interface BaseSegment {
	id: ItinerarySegmentId;
	tone: ItinerarySegmentTone;
	/** Plain-language description, for a marker's `aria-label` and for the live region
	 *  `ItineraryMap` announces a selection change through. */
	label: string;
}

export interface ItineraryPointSegment extends BaseSegment {
	kind: 'point';
	coordinates: Coordinates;
}

export interface ItineraryLineSegment extends BaseSegment {
	kind: 'line';
	role: 'flight' | 'transfer';
	/** Already densified into a great-circle arc for a flight; a plain two-point line
	 *  for a ground transfer, since no provider `Transfer` (`src/lib/domain/transfer.ts`)
	 *  carries an actual route shape, only a mode and a duration — a straight hop is the
	 *  only geometry available for those. */
	coordinates: Coordinates[];
}

export type ItinerarySegment = ItineraryPointSegment | ItineraryLineSegment;

/** A point drawn on the map with no segment id of its own — currently only the
 *  destination airport. See `segment-id.ts` for why it has none to select. */
export interface ItineraryWaypoint {
	coordinates: Coordinates;
	label: string;
	tone: ItinerarySegmentTone;
}

export interface ItineraryMapModel {
	segments: ItinerarySegment[];
	extraWaypoints: ItineraryWaypoint[];
}

export function buildItineraryMapModel(
	itinerary: Itinerary,
	connectionAirport: Airport
): ItineraryMapModel {
	const segments: ItinerarySegment[] = [];

	if (itinerary.originLocation) {
		segments.push({
			kind: 'point',
			id: 'origin-location',
			tone: 'neutral',
			label: itinerary.originLocation.label,
			coordinates: itinerary.originLocation.coordinates
		});
	}

	// Brief invariant (domain/itinerary.ts): transferToOriginAirport is present only
	// alongside originLocation. Checking both anyway rather than trusting the invariant
	// holds, since a line with only one real endpoint has nothing to draw.
	if (itinerary.transferToOriginAirport && itinerary.originLocation) {
		segments.push({
			kind: 'line',
			id: 'transfer-to-origin-airport',
			role: 'transfer',
			tone: 'neutral',
			label: `Transfer to ${itinerary.originAirport.iataCode}`,
			coordinates: [itinerary.originLocation.coordinates, itinerary.originAirport.coordinates]
		});
	}

	segments.push({
		kind: 'point',
		id: 'origin-waiting',
		tone: 'neutral',
		label: `${itinerary.originAirport.city.name} (${itinerary.originAirport.iataCode})`,
		coordinates: itinerary.originAirport.coordinates
	});

	segments.push({
		kind: 'line',
		id: 'outbound-flight',
		role: 'flight',
		tone: 'neutral',
		label: `Flight ${itinerary.outboundFlight.flightNumber} to ${connectionAirport.city.name}`,
		coordinates: greatCircleArc(itinerary.originAirport.coordinates, connectionAirport.coordinates)
	});

	segments.push({
		kind: 'line',
		id: 'transfer-to-hotel',
		role: 'transfer',
		tone: 'stopover',
		label: `Transfer to ${itinerary.stay.property.name}`,
		coordinates: [connectionAirport.coordinates, itinerary.stay.property.coordinates]
	});

	segments.push({
		kind: 'point',
		id: 'free-time',
		tone: 'stopover',
		label: itinerary.stay.property.name,
		coordinates: itinerary.stay.property.coordinates
	});

	segments.push({
		kind: 'line',
		id: 'transfer-to-connection-airport',
		role: 'transfer',
		tone: 'stopover',
		label: `Transfer to ${connectionAirport.iataCode}`,
		coordinates: [itinerary.stay.property.coordinates, connectionAirport.coordinates]
	});

	segments.push({
		kind: 'point',
		id: 'connection-waiting',
		tone: 'stopover',
		label: `${connectionAirport.city.name} (${connectionAirport.iataCode})`,
		coordinates: connectionAirport.coordinates
	});

	segments.push({
		kind: 'line',
		id: 'onward-flight',
		role: 'flight',
		tone: 'neutral',
		label: `Flight ${itinerary.onwardFlight.flightNumber} to ${itinerary.destinationAirport.city.name}`,
		coordinates: greatCircleArc(connectionAirport.coordinates, itinerary.destinationAirport.coordinates)
	});

	if (itinerary.transferToDestinationLocation && itinerary.destinationLocation) {
		segments.push({
			kind: 'line',
			id: 'transfer-to-destination-location',
			role: 'transfer',
			tone: 'neutral',
			label: `Transfer to ${itinerary.destinationLocation.label}`,
			coordinates: [
				itinerary.destinationAirport.coordinates,
				itinerary.destinationLocation.coordinates
			]
		});
	}

	if (itinerary.destinationLocation) {
		segments.push({
			kind: 'point',
			id: 'destination-location',
			tone: 'neutral',
			label: itinerary.destinationLocation.label,
			coordinates: itinerary.destinationLocation.coordinates
		});
	}

	// Always drawn — the onward flight has to land somewhere — but never independently
	// selectable; see segment-id.ts for why.
	const extraWaypoints: ItineraryWaypoint[] = [
		{
			coordinates: itinerary.destinationAirport.coordinates,
			label: `${itinerary.destinationAirport.city.name} (${itinerary.destinationAirport.iataCode})`,
			tone: 'neutral'
		}
	];

	return { segments, extraWaypoints };
}

/** Every coordinate in the model, for the map's initial "show the whole chain" view
 *  before anything is selected (issue #26: "Draw the whole chain"). */
export function allCoordinates(model: ItineraryMapModel): Coordinates[] {
	const points: Coordinates[] = [];
	for (const segment of model.segments) {
		if (segment.kind === 'point') points.push(segment.coordinates);
		else points.push(...segment.coordinates);
	}
	for (const waypoint of model.extraWaypoints) points.push(waypoint.coordinates);
	return points;
}

/** The single segment matching an id, or `undefined` if the itinerary never had that
 *  optional stretch (e.g. no `originLocation` means no `'origin-location'` segment). */
export function findSegment(
	model: ItineraryMapModel,
	id: ItinerarySegmentId
): ItinerarySegment | undefined {
	return model.segments.find((segment) => segment.id === id);
}
