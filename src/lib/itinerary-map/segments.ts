import type { Airport, Coordinates, Itinerary, Transfer } from '$lib/domain';
// Reaching into the components layer for one pure string function, deliberately: see
// `absenceNote` below for why the map must not keep its own copy of this wording.
import { unroutedLegNote, type UnroutedLeg } from '$lib/components/itinerary-timeline-format';
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
 * Issue #141: how precisely a point's coordinates locate the thing it names.
 *
 * `'exact'` is an address: an airport, a hotel, the place the traveller typed in. Every
 * point is that, except one. The stopover with no bed priced happens *somewhere in the
 * connection city*, and the only coordinate this app has for that city is the airport's
 * own (`data/airports.ts`: "OurAirports has no separate city geometry, only the
 * airport's"). Marking it `'city'` is what stops `ItineraryMap` framing the runway at
 * street level and calling it the free city, and what tells the status line to say why
 * the map stopped where it did.
 */
export type ItineraryPointPrecision = 'exact' | 'city';

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
	precision: ItineraryPointPrecision;
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
	/**
	 * Issue #141: why a step the timeline renders has no geometry here.
	 *
	 * `ItineraryTimeline` prints every schedule step in a fixed order whether or not it
	 * has anything behind it, deliberately (`itinerary-timeline-format.ts`: "a row that
	 * vanishes for one itinerary and not another makes two trips harder to read against
	 * each other"). The map cannot do the same — there is no line to draw for a leg that
	 * was never routed — so selecting one of those rows used to move nothing and say
	 * nothing, with an empty `role="status"` for a screen reader to not hear. Every id
	 * that can be selected but not drawn now carries a sentence about the itinerary
	 * instead, and `every id is either drawn or explained` is a tested invariant.
	 */
	absentSegmentNotes: Partial<Record<ItinerarySegmentId, string>>;
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
		})),
		absentSegmentNotes: model.absentSegmentNotes
	};
}

/**
 * What the map says about a transfer step it has no line for (issue #141): that nothing
 * moved, and then the timeline row's own sentence for why.
 *
 * The reason comes from `unroutedLegNote` rather than being written a second time here.
 * A parallel copy drifted within a day of being written: issue #161 gave these two legs
 * the connection city as a second possible destination, so "no bed priced, so there is
 * nowhere to travel to" stopped being true, and one of the two copies would have gone on
 * saying it. One sentence, one place, and the row a traveller clicked and the caption
 * they then read cannot disagree.
 */
function absenceNote(itinerary: Itinerary, leg: UnroutedLeg): string {
	const reason = unroutedLegNote(leg, {
		hasStay: itinerary.stay !== undefined,
		nightsInConnection: itinerary.nightsInConnection
	});
	return `Nothing to draw. ${reason}`;
}

export function buildItineraryMapModel(
	itinerary: Itinerary,
	connectionAirport: Airport
): ItineraryMapModel {
	const segments: ItinerarySegment[] = [];
	const absentSegmentNotes: Partial<Record<ItinerarySegmentId, string>> = {};

	if (itinerary.originLocation) {
		segments.push({
			kind: 'point',
			id: 'origin-location',
			tone: 'neutral',
			markerKind: 'start',
			label: itinerary.originLocation.label,
			coordinates: itinerary.originLocation.coordinates,
			precision: 'exact'
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
	} else if (itinerary.originLocation) {
		// The timeline renders this row whenever there is an origin location, routed or
		// not, so the map owes it an answer whenever there is one too.
		absentSegmentNotes['transfer-to-origin-airport'] = absenceNote(itinerary, 'to-origin-airport');
	}

	segments.push({
		kind: 'point',
		id: 'origin-waiting',
		tone: 'neutral',
		markerKind: 'airport',
		label: `${itinerary.originAirport.city.name} (${itinerary.originAirport.iataCode})`,
		coordinates: itinerary.originAirport.coordinates,
		precision: 'exact'
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

	// Where the free time is actually spent, and how precisely this app knows it.
	//
	// A priced bed is an address. Failing that, issue #161 gives the two in-city legs a
	// real destination anyway — `Airport.city.coordinates`, the hand-checked centre issue
	// #162 keeps for the eleven airports whose runway sits outside the city it is sold as
	// — and both transfers can then exist with no `stay` at all (`algorithm/build.ts`:
	// "Both transfers can now be present with `stay` absent"). Failing THAT, the stopover
	// still happened somewhere real, and the airport's own coordinates are the only ones
	// left; issue #141 marks that case `'city'` so the camera frames the city rather than
	// the runway, and `ItineraryMap` stacks the marker clear of the airport pill it would
	// otherwise be hidden underneath.
	const cityCentre = connectionAirport.city.coordinates;
	const stopoverIsSomewhereOfItsOwn = itinerary.stay !== undefined || cityCentre !== undefined;
	const stopoverCoordinates =
		itinerary.stay?.property.coordinates ?? cityCentre ?? connectionAirport.coordinates;
	const stopoverName = itinerary.stay?.property.name ?? connectionAirport.city.name;

	// Gated on the destination existing rather than on `stay`: a leg into town stands on
	// its own, and calling it absent because no bed was priced would be asserting a cause
	// the itinerary contradicts.
	if (itinerary.transferToHotel && stopoverIsSomewhereOfItsOwn) {
		const line = transferLine(
			connectionAirport.coordinates,
			stopoverCoordinates,
			itinerary.transferToHotel
		);
		segments.push({
			kind: 'line',
			id: 'transfer-to-hotel',
			role: 'transfer',
			tone: 'stopover',
			geometryKind: line.geometryKind,
			label: transferLabel(`Transfer to ${stopoverName}`, line.geometryKind),
			coordinates: line.coordinates
		});
	} else {
		absentSegmentNotes['transfer-to-hotel'] = absenceNote(itinerary, 'to-hotel');
	}

	segments.push({
		kind: 'point',
		id: 'free-time',
		tone: 'stopover',
		markerKind: 'stay',
		label: itinerary.stay ? itinerary.stay.property.name : `Stopover in ${connectionAirport.city.name}`,
		coordinates: stopoverCoordinates,
		// A city centre is a real point and still not an address: nobody spends their free
		// time standing on it. Only a booked bed is exact.
		precision: itinerary.stay ? 'exact' : 'city'
	});

	if (itinerary.transferToConnectionAirport && stopoverIsSomewhereOfItsOwn) {
		const line = transferLine(
			stopoverCoordinates,
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
	} else {
		absentSegmentNotes['transfer-to-connection-airport'] = absenceNote(itinerary, 'from-hotel');
	}

	segments.push({
		kind: 'point',
		id: 'connection-waiting',
		tone: 'stopover',
		markerKind: 'airport',
		label: `${connectionAirport.city.name} (${connectionAirport.iataCode})`,
		coordinates: connectionAirport.coordinates,
		precision: 'exact'
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
	} else if (itinerary.destinationLocation) {
		absentSegmentNotes['transfer-to-destination-location'] = absenceNote(itinerary, 'to-destination-location');
	}

	if (itinerary.destinationLocation) {
		segments.push({
			kind: 'point',
			id: 'destination-location',
			tone: 'neutral',
			markerKind: 'end',
			label: itinerary.destinationLocation.label,
			coordinates: itinerary.destinationLocation.coordinates,
			precision: 'exact'
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

	return singleFrame({ segments, extraWaypoints, absentSegmentNotes });
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
