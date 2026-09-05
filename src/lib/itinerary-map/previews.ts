/**
 * What the frozen previews draw (issue #280).
 *
 * The owner asked for a permanent, tiny, frozen flight picture on the card whose only job
 * is showing "how straight the itinerary is", and three small ground pictures beside it,
 * one per transport leg, each opening a full map in a dialog. He also set the rule that
 * decides the layout: "if one is not existing, for example origin location was not set,
 * the map for that part is not shown, so we would show only 2 maps in this case sigtly
 * wider."
 *
 * That rule lives here rather than in the component. `buildGroundLegPreviews` returns only
 * the legs the itinerary actually has, so the row renders `previews.length` columns and
 * two-instead-of-three falls out of the data with no branch to get wrong. The component
 * has no opinion about which legs exist.
 *
 * Everything is derived from `ItineraryMapModel`, never from `Itinerary` directly. The
 * model has already resolved the connection airport, replaced OSRM's snapped endpoints
 * with the itinerary's exact ones, and rewritten every longitude into one continuous frame
 * (`segments.ts`, `singleFrame`). A preview built from the raw itinerary would redo all
 * three and get at least one of them wrong.
 */

import type { Coordinates } from '$lib/domain';
import { greatCircleDistanceKm } from '$lib/domain';
import { greatCircleArc } from './geo';
import type { ItinerarySegmentId } from './segment-id';
import { findSegment, type ItineraryLineSegment, type ItineraryMapModel } from './segments';
import type { ItineraryLineGeometryKind, ItinerarySegmentTone } from './segments';

/** A polyline in a preview, carrying the two facts that decide how it is stroked. */
export interface PreviewLine {
	coordinates: Coordinates[];
	/** `'schematic'` draws dashed, the same signal the full map uses for a leg nobody
	 *  routed. Never restyled to match `'real'`: the dash is the honesty. */
	geometryKind: ItineraryLineGeometryKind;
	tone: ItinerarySegmentTone;
}

export interface PreviewPoint {
	coordinates: Coordinates;
	tone: ItinerarySegmentTone;
}

export type GroundLegPreviewId = 'origin-transport' | 'stopover-transport' | 'destination-transport';

export interface GroundLegPreview {
	id: GroundLegPreviewId;
	/** The short caption under the thumbnail. Deliberately the same words the timeline
	 *  already uses for these rows, so the picture and the row a traveller taps next are
	 *  not two vocabularies for one journey. */
	label: string;
	/**
	 * The full sentence: the button's accessible name, and the dialog's heading.
	 *
	 * Assembled from the segments' own labels rather than written again here. Those labels
	 * already carry "(straight-line estimate)" where the geometry is a guess, and a second
	 * copy of that wording is exactly the drift `segments.ts` documents in `absenceNote`.
	 */
	title: string;
	/** The segment the dialog opens focused on, so the big map lands on the leg that was
	 *  tapped and the traveller can pan from there to the rest. */
	focusSegmentId: ItinerarySegmentId;
	lines: PreviewLine[];
	points: PreviewPoint[];
}

/** Which model segments each preview draws, in journey order. The stopover preview owns
 *  both in-city legs: the owner counted "hotel transport" as one of three parts, and the
 *  ride in and the ride back are one hop drawn twice. */
const GROUND_LEG_SEGMENTS: {
	id: GroundLegPreviewId;
	label: string;
	segmentIds: readonly ItinerarySegmentId[];
}[] = [
	{ id: 'origin-transport', label: 'To the airport', segmentIds: ['transfer-to-origin-airport'] },
	{
		id: 'stopover-transport',
		label: 'The stopover',
		segmentIds: ['transfer-to-hotel', 'transfer-to-connection-airport']
	},
	{
		id: 'destination-transport',
		label: 'To the destination',
		segmentIds: ['transfer-to-destination-location']
	}
];

/** Endpoint dots, taken from the polylines themselves rather than looked up among the
 *  point segments. `transferLine` (segments.ts) already guarantees a transfer's first and
 *  last coordinates are the itinerary's own exact endpoints, so the line knows where its
 *  ends are and a lookup could only disagree with it. */
function endpointsOf(lines: readonly PreviewLine[]): PreviewPoint[] {
	const seen = new Set<string>();
	const points: PreviewPoint[] = [];
	for (const line of lines) {
		for (const coordinates of [line.coordinates[0], line.coordinates[line.coordinates.length - 1]]) {
			if (!coordinates) continue;
			const key = `${coordinates.latitude.toFixed(5)},${coordinates.longitude.toFixed(5)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			points.push({ coordinates, tone: line.tone });
		}
	}
	return points;
}

function lineSegment(model: ItineraryMapModel, id: ItinerarySegmentId): ItineraryLineSegment | undefined {
	const segment = findSegment(model, id);
	return segment?.kind === 'line' ? segment : undefined;
}

export function buildGroundLegPreviews(model: ItineraryMapModel): GroundLegPreview[] {
	const previews: GroundLegPreview[] = [];
	for (const spec of GROUND_LEG_SEGMENTS) {
		const segments = spec.segmentIds.map((id) => lineSegment(model, id)).filter((s) => s !== undefined);
		// The owner's rule: a leg the itinerary never had gets no thumbnail at all, and the
		// row is one column narrower.
		if (segments.length === 0) continue;
		const lines = segments.map((segment) => ({
			coordinates: segment.coordinates,
			geometryKind: segment.geometryKind,
			tone: segment.tone
		}));
		previews.push({
			id: spec.id,
			label: spec.label,
			title: segments.map((segment) => segment.label).join('. '),
			focusSegmentId: segments[0].id,
			lines,
			points: endpointsOf(lines)
		});
	}
	return previews;
}

/**
 * The flight ornament: the route as flown, and the shortest line that exists between the
 * same two airports, so the gap between them is the detour.
 *
 * `directLine` is the one thing on this picture that is not part of the itinerary. It is a
 * great-circle arc between the origin and destination airports and nothing more: no
 * carrier flies it, no fare was quoted for it, and it exists only as the "could not
 * possibly be shorter than this" baseline. Everything downstream keeps that distinction
 * visible. `RoutePreview` strokes it thin, muted and dashed against the solid flown route,
 * and `FlightShape` captions it in words. This app spent a night removing map lines that
 * implied routes they did not have; a dashed arc silently promoted to "your flight" would
 * put one straight back.
 */
export interface FlightShape {
	/** The two flown great-circle arcs, origin to connection to destination. */
	lines: PreviewLine[];
	points: PreviewPoint[];
	/** The shortest possible line between the end airports. Not a leg of this trip. */
	directLine: Coordinates[];
	/** Great-circle kilometres actually flown, both legs added up. */
	flownKm: number;
	/** Great-circle kilometres between the end airports. */
	directKm: number;
	/** How much further the connection costs, in kilometres. Never negative: the triangle
	 *  inequality on a sphere makes a two-leg path at least as long as the direct one, and
	 *  a rounding wobble at the zero end is clamped rather than printed as "-0 km". */
	extraKm: number;
}

export function buildFlightShape(model: ItineraryMapModel): FlightShape | undefined {
	const outbound = lineSegment(model, 'outbound-flight');
	const onward = lineSegment(model, 'onward-flight');
	if (!outbound || !onward) return undefined;

	const origin = outbound.coordinates[0];
	const connection = outbound.coordinates[outbound.coordinates.length - 1];
	const destination = onward.coordinates[onward.coordinates.length - 1];

	const flownKm =
		greatCircleDistanceKm(origin, connection) + greatCircleDistanceKm(connection, destination);
	const directKm = greatCircleDistanceKm(origin, destination);

	const lines: PreviewLine[] = [outbound, onward].map((segment) => ({
		coordinates: segment.coordinates,
		geometryKind: segment.geometryKind,
		tone: segment.tone
	}));

	return {
		lines,
		points: [
			{ coordinates: origin, tone: 'neutral' },
			{ coordinates: connection, tone: 'stopover' },
			{ coordinates: destination, tone: 'neutral' }
		],
		// Built from the model's own endpoints, not the raw airport coordinates, so the
		// baseline sits in the same longitude frame as the arcs it is drawn against. An
		// antimeridian trip whose arcs run past +180 would otherwise get a baseline drawn a
		// whole world away.
		directLine: greatCircleArc(origin, destination),
		flownKm,
		directKm,
		extraKm: Math.max(0, flownKm - directKm)
	};
}
