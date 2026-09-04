import type { Airport, Coordinates, Itinerary, Transfer } from '$lib/domain';
import { greatCircleArc, longitudeNear } from './geo';
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

/**
 * Issue #118: which marker `ItineraryMap` draws for a point. Airports keep the existing
 * pill-with-IATA-code treatment; the other three get a visibly different pin, since the
 * owner's own complaint was that the start point, the hotel and the end point read as
 * the same kind of dot as an airport rather than as what they actually are.
 */
export type ItineraryMarkerKind = 'airport' | 'start' | 'stay' | 'end';

/**
 * Issue #118: whether a line segment's `coordinates` trace a real, provider-fetched
 * route (`'real'`) or a straight hop between two known endpoints because no route shape
 * was available (`'schematic'`). A flight's great-circle arc is always `'real'` — it is
 * the exact path a flight actually follows, even though no single point on it is where a
 * plane physically was. A transfer is `'real'` only when its `Transfer.path` (OSRM's own
 * route geometry, `providers/transfers/osrm.ts`) came through; otherwise it's
 * `'schematic'`, and `ItineraryMap`'s dashed, translucent transfer styling is what keeps
 * that schematic hop from being mistaken for a real road on the basemap underneath it.
 */
export type ItineraryLineGeometryKind = 'real' | 'schematic';

interface BaseSegment {
	id: ItinerarySegmentId;
	tone: ItinerarySegmentTone;
	/** Plain-language description, for a marker's `aria-label` and for the live region
	 *  `ItineraryMap` announces a selection change through. */
	label: string;
}

export interface ItineraryPointSegment extends BaseSegment {
	kind: 'point';
	markerKind: ItineraryMarkerKind;
	coordinates: Coordinates;
}

export interface ItineraryLineSegment extends BaseSegment {
	kind: 'line';
	role: 'flight' | 'transfer';
	geometryKind: ItineraryLineGeometryKind;
	/** Densified into a great-circle arc for a flight; either OSRM's real route or a
	 *  straight two-point hop for a ground transfer — see `geometryKind`. */
	coordinates: Coordinates[];
}

export type ItinerarySegment = ItineraryPointSegment | ItineraryLineSegment;

/** A point drawn on the map with no segment id of its own — currently only the
 *  destination airport. See `segment-id.ts` for why it has none to select. */
export interface ItineraryWaypoint {
	coordinates: Coordinates;
	label: string;
	tone: ItinerarySegmentTone;
	markerKind: ItineraryMarkerKind;
}

export interface ItineraryMapModel {
	segments: ItinerarySegment[];
	extraWaypoints: ItineraryWaypoint[];
}

/**
 * Coordinates and honesty tag for one ground-transfer leg (issue #118). Draws OSRM's own
 * route geometry (`transfer.path`) when it exists, with its first and last points
 * replaced by the itinerary's own exact endpoint coordinates — OSRM snaps to the nearest
 * routable node, which is rarely the exact hotel or airport point this map already knows,
 * and leaving that snap in place would draw a line stopping visibly short of the marker
 * it is meant to touch. Falls back to a plain two-point hop, tagged `'schematic'`, when
 * no path was ever fetched: a `transit` leg (Transitous returns a schedule, not a
 * geometry) or a pair OSRM couldn't route between at all.
 */
function transferLine(
	from: Coordinates,
	to: Coordinates,
	transfer: Transfer | undefined
): { coordinates: Coordinates[]; geometryKind: ItineraryLineGeometryKind } {
	const path = transfer?.path;
	if (path && path.length >= 2) {
		return { coordinates: [from, ...path.slice(1, -1), to], geometryKind: 'real' };
	}
	return { coordinates: [from, to], geometryKind: 'schematic' };
}

/** Appends an honest caveat to a transfer's label when its geometry is a straight-line
 *  guess (AGENTS.md: "say what you do not know rather than guessing") — read aloud by
 *  the same live region a sighted user gets the dashed line style from, so a screen
 *  reader user gets the same "this isn't a real route" signal the line style carries
 *  visually. */
function transferLabel(base: string, geometryKind: ItineraryLineGeometryKind): string {
	return geometryKind === 'schematic' ? `${base} (straight-line estimate)` : base;
}

/**
 * Rewrites a whole model into one continuous longitude frame, so the trip reads as one
 * journey rather than a jump across the map.
 *
 * `greatCircleArc` already keeps a single flight's own polyline continuous, which was
 * enough while every route this app returned stayed inside Europe and Africa. It is not
 * enough for a trip that crosses the antimeridian: an Auckland to Tokyo arc leaves
 * Auckland at 174.8 and ends at -220.4 (the same place as 139.6, one world to the west),
 * and everything built after it — the connection airport's marker, the onward flight, the
 * hotel — still carries its raw +139.6. The line and the marker meant to sit at its end
 * then land a whole world apart, `boundsOfCoordinates` spans 360°, and the camera answers
 * by zooming out to the entire globe with the route drawn back across all of it.
 *
 * So the chain is walked in travel order and every coordinate is placed in the copy of
 * the world nearest the point before it. A polyline is shifted as a whole (by the offset
 * its first point needs) rather than point by point, which preserves the internal
 * continuity `greatCircleArc` and OSRM's own geometry already have.
 *
 * MapLibre is fine with the result: a `LngLat` beyond ±180 projects onto the world copy
 * it names, and `renderWorldCopies` (on by default) is what draws the basemap there.
 */
function singleFrame(model: ItineraryMapModel): ItineraryMapModel {
	let reference: number | undefined;

	function place(coordinate: Coordinates): Coordinates {
		if (reference === undefined) {
			reference = coordinate.longitude;
			return coordinate;
		}
		const longitude = longitudeNear(reference, coordinate.longitude);
		reference = longitude;
		return { latitude: coordinate.latitude, longitude };
	}

	function placeLine(coordinates: Coordinates[]): Coordinates[] {
		if (coordinates.length === 0) return coordinates;
		const offset = place(coordinates[0]).longitude - coordinates[0].longitude;
		if (offset !== 0) {
			coordinates = coordinates.map((c) => ({
				latitude: c.latitude,
				longitude: c.longitude + offset
			}));
		}
		reference = coordinates[coordinates.length - 1].longitude;
		return coordinates;
	}

	return {
		segments: model.segments.map((segment) =>
			segment.kind === 'point'
				? { ...segment, coordinates: place(segment.coordinates) }
				: { ...segment, coordinates: placeLine(segment.coordinates) }
		),
		extraWaypoints: model.extraWaypoints.map((waypoint) => ({
			...waypoint,
			coordinates: place(waypoint.coordinates)
		}))
	};
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
			markerKind: 'start',
			label: itinerary.originLocation.label,
			coordinates: itinerary.originLocation.coordinates
		});
	}

	// Brief invariant (domain/itinerary.ts): transferToOriginAirport is present only
	// alongside originLocation. Checking both anyway rather than trusting the invariant
	// holds, since a line with only one real endpoint has nothing to draw.
	if (itinerary.transferToOriginAirport && itinerary.originLocation) {
		const line = transferLine(
			itinerary.originLocation.coordinates,
			itinerary.originAirport.coordinates,
			itinerary.transferToOriginAirport
		);
		segments.push({
			kind: 'line',
			id: 'transfer-to-origin-airport',
			role: 'transfer',
			tone: 'neutral',
			geometryKind: line.geometryKind,
			label: transferLabel(`Transfer to ${itinerary.originAirport.iataCode}`, line.geometryKind),
			coordinates: line.coordinates
		});
	}

	segments.push({
		kind: 'point',
		id: 'origin-waiting',
		tone: 'neutral',
		markerKind: 'airport',
		label: `${itinerary.originAirport.city.name} (${itinerary.originAirport.iataCode})`,
		coordinates: itinerary.originAirport.coordinates
	});

	segments.push({
		kind: 'line',
		id: 'outbound-flight',
		role: 'flight',
		tone: 'neutral',
		geometryKind: 'real',
		label: `Flight ${itinerary.outboundFlight.flightNumber} to ${connectionAirport.city.name}`,
		coordinates: greatCircleArc(itinerary.originAirport.coordinates, connectionAirport.coordinates)
	});

	// Issue #94: `itinerary.stay` (and, alongside it, `transferToHotel`/
	// `transferToConnectionAirport`) is `undefined` when no bed was priced for this
	// connection. There is then nowhere for an in-city transfer to go, so those two
	// segments simply don't exist — same treatment `transfer-to-origin-airport` already
	// gets when there is no `originLocation` — and `free-time` falls back to a point at
	// the connection airport itself: the layover still happened somewhere real, even
	// without a hotel to anchor it to.
	if (itinerary.stay && itinerary.transferToHotel) {
		const line = transferLine(
			connectionAirport.coordinates,
			itinerary.stay.property.coordinates,
			itinerary.transferToHotel
		);
		segments.push({
			kind: 'line',
			id: 'transfer-to-hotel',
			role: 'transfer',
			tone: 'stopover',
			geometryKind: line.geometryKind,
			label: transferLabel(`Transfer to ${itinerary.stay.property.name}`, line.geometryKind),
			coordinates: line.coordinates
		});
	}

	segments.push({
		kind: 'point',
		id: 'free-time',
		tone: 'stopover',
		markerKind: 'stay',
		label: itinerary.stay ? itinerary.stay.property.name : `Stopover at ${connectionAirport.city.name}`,
		coordinates: itinerary.stay ? itinerary.stay.property.coordinates : connectionAirport.coordinates
	});

	if (itinerary.stay && itinerary.transferToConnectionAirport) {
		const line = transferLine(
			itinerary.stay.property.coordinates,
			connectionAirport.coordinates,
			itinerary.transferToConnectionAirport
		);
		segments.push({
			kind: 'line',
			id: 'transfer-to-connection-airport',
			role: 'transfer',
			tone: 'stopover',
			geometryKind: line.geometryKind,
			label: transferLabel(`Transfer to ${connectionAirport.iataCode}`, line.geometryKind),
			coordinates: line.coordinates
		});
	}

	segments.push({
		kind: 'point',
		id: 'connection-waiting',
		tone: 'stopover',
		markerKind: 'airport',
		label: `${connectionAirport.city.name} (${connectionAirport.iataCode})`,
		coordinates: connectionAirport.coordinates
	});

	segments.push({
		kind: 'line',
		id: 'onward-flight',
		role: 'flight',
		tone: 'neutral',
		geometryKind: 'real',
		label: `Flight ${itinerary.onwardFlight.flightNumber} to ${itinerary.destinationAirport.city.name}`,
		coordinates: greatCircleArc(connectionAirport.coordinates, itinerary.destinationAirport.coordinates)
	});

	if (itinerary.transferToDestinationLocation && itinerary.destinationLocation) {
		const line = transferLine(
			itinerary.destinationAirport.coordinates,
			itinerary.destinationLocation.coordinates,
			itinerary.transferToDestinationLocation
		);
		segments.push({
			kind: 'line',
			id: 'transfer-to-destination-location',
			role: 'transfer',
			tone: 'neutral',
			geometryKind: line.geometryKind,
			label: transferLabel(`Transfer to ${itinerary.destinationLocation.label}`, line.geometryKind),
			coordinates: line.coordinates
		});
	}

	if (itinerary.destinationLocation) {
		segments.push({
			kind: 'point',
			id: 'destination-location',
			tone: 'neutral',
			markerKind: 'end',
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
			tone: 'neutral',
			markerKind: 'airport'
		}
	];

	return singleFrame({ segments, extraWaypoints });
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
