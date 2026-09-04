import type { Coordinates } from '$lib/domain';

/**
 * Pure spherical geometry for `ItineraryMap`. No MapLibre, no Svelte, no I/O — this is
 * the part of issue #26 that is worth testing without a browser at all.
 */

function toRadians(degrees: number): number {
	return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
	return (radians * 180) / Math.PI;
}

/** Radians between two points on a sphere (haversine central angle). */
function centralAngle(from: Coordinates, to: Coordinates): number {
	const φ1 = toRadians(from.latitude);
	const φ2 = toRadians(to.latitude);
	const Δφ = toRadians(to.latitude - from.latitude);
	const Δλ = toRadians(to.longitude - from.longitude);
	const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
	return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * A point a `fraction` of the way from `from` to `to` along the great circle joining
 * them, given their central angle in radians. Ed Williams' aviation formulary
 * "intermediate point on a great circle" formula — the same maths a real flight
 * planner uses, since a flight actually does fly this path, not a straight line on a
 * flat map.
 */
function intermediatePoint(
	from: Coordinates,
	to: Coordinates,
	angle: number,
	fraction: number
): Coordinates {
	const φ1 = toRadians(from.latitude);
	const λ1 = toRadians(from.longitude);
	const φ2 = toRadians(to.latitude);
	const λ2 = toRadians(to.longitude);

	const a = Math.sin((1 - fraction) * angle) / Math.sin(angle);
	const b = Math.sin(fraction * angle) / Math.sin(angle);

	const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
	const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
	const z = a * Math.sin(φ1) + b * Math.sin(φ2);

	return {
		latitude: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
		longitude: toDegrees(Math.atan2(y, x))
	};
}

/**
 * Rewrites longitudes so consecutive points never jump by more than 180°, e.g.
 * 179 -> 181 rather than 179 -> -179. Raw coordinates crossing the antimeridian would
 * otherwise draw as a spurious line all the way back across the map: MapLibre, like any
 * Mercator-based renderer, wants a continuous coordinate sequence, not a wrapped one.
 */
function unwrapLongitudes(points: Coordinates[]): Coordinates[] {
	const result: Coordinates[] = [points[0]];
	for (let i = 1; i < points.length; i++) {
		const previous = result[i - 1].longitude;
		let longitude = points[i].longitude;
		while (longitude - previous > 180) longitude -= 360;
		while (longitude - previous < -180) longitude += 360;
		result.push({ latitude: points[i].latitude, longitude });
	}
	return result;
}

/**
 * A polyline tracing the great-circle path between two points rather than the straight
 * Mercator line MapLibre would otherwise draw between two raw coordinates. Issue #26:
 * "Flight legs as great-circle arcs, not straight lines on a flat projection... [a
 * straight line] is geometrically wrong and looks it." `segments` intermediate points
 * is enough to read as a smooth curve at any zoom this app's map reaches; MapLibre
 * still just draws straight segments between them, so more points is a smoother curve,
 * never a correctness requirement.
 */
export function greatCircleArc(from: Coordinates, to: Coordinates, segments = 64): Coordinates[] {
	const angle = centralAngle(from, to);

	// Coincident points: nothing to interpolate. Antipodal points: every great circle
	// through them is equally valid, and no route in this app's domain is ever
	// antipodal, so a straight two-point fallback is fine rather than picking one
	// arbitrarily.
	if (angle < 1e-9 || Math.abs(Math.PI - angle) < 1e-6) {
		return [from, to];
	}

	// The endpoints are exact inputs, not trig round-trips: at fraction 0 or 1 the
	// interpolation formula reduces to `from`/`to` mathematically, but floating-point
	// error in the sin/atan2 chain still perturbs the last couple of decimal places,
	// which would make a segment's own arc disagree with the airport coordinates it is
	// supposed to start and end at.
	const points: Coordinates[] = [from];
	for (let i = 1; i < segments; i++) {
		points.push(intermediatePoint(from, to, angle, i / segments));
	}
	points.push(to);
	return unwrapLongitudes(points);
}

/** `[west, south, east, north]` — the corner order MapLibre's `fitBounds` accepts as
 *  two `[lng, lat]` pairs. */
export type LngLatBounds = readonly [west: number, south: number, east: number, north: number];

/** Bounding box of a set of points. Throws on empty input rather than returning a
 *  fake box: every caller here has a real itinerary with at least one coordinate, so an
 *  empty array is a bug upstream, not a case to paper over. */
export function boundsOfCoordinates(points: readonly Coordinates[]): LngLatBounds {
	if (points.length === 0) {
		throw new Error('boundsOfCoordinates: at least one point is required');
	}
	let west = points[0].longitude;
	let east = points[0].longitude;
	let south = points[0].latitude;
	let north = points[0].latitude;
	for (const point of points) {
		west = Math.min(west, point.longitude);
		east = Math.max(east, point.longitude);
		south = Math.min(south, point.latitude);
		north = Math.max(north, point.latitude);
	}
	return [west, south, east, north];
}

/**
 * Degrees of longitude/latitude below which a bounding box is treated as a single
 * point rather than fed to `fitBounds` — MapLibre still accepts a zero-area box, but
 * the zoom it picks is its own internal maximum, far tighter than a hotel-to-airport
 * walk actually needs to read clearly.
 */
const MIN_BOUNDS_SPAN_DEGREES = 0.01; // roughly 1km at temperate latitudes

/** The zoom used for a `point` view: close enough that a single airport or hotel is
 *  legible, not so close the surrounding city disappears. */
export const POINT_VIEW_ZOOM = 13;

export type MapView =
	| { kind: 'bounds'; bounds: LngLatBounds }
	| { kind: 'point'; center: readonly [number, number]; zoom: number };

/**
 * How the map should frame a segment: a real bounding box for anything spanning real
 * distance, or a fixed close-in zoom for a single waypoint. A zero-area bounding box
 * does not mean "zoom in as far as possible" — it means "there is only one point here".
 */
export function viewForCoordinates(points: readonly Coordinates[]): MapView {
	const bounds = boundsOfCoordinates(points);
	const [west, south, east, north] = bounds;
	if (east - west < MIN_BOUNDS_SPAN_DEGREES && north - south < MIN_BOUNDS_SPAN_DEGREES) {
		return {
			kind: 'point',
			center: [(west + east) / 2, (south + north) / 2],
			zoom: POINT_VIEW_ZOOM
		};
	}
	return { kind: 'bounds', bounds };
}
