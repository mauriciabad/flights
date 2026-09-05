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
 * The same place as `longitude`, expressed in whichever 360° copy of the world sits
 * nearest `reference`: 179 stays 179 next to 170, and becomes -181 next to -175.
 *
 * Mercator renderers, MapLibre included, draw whatever coordinates they are given
 * rather than working out that -179 is two degrees from 179, so a pair of points either
 * side of the antimeridian has to be written in one frame before anything is drawn or
 * framed with it. Exported because the geometry is only half the problem: the camera and
 * the markers have to agree with the line (`segments.ts`, `singleFrame`).
 */
export function longitudeNear(reference: number, longitude: number): number {
	let result = longitude;
	while (result - reference > 180) result -= 360;
	while (result - reference < -180) result += 360;
	return result;
}

/**
 * Rewrites longitudes so consecutive points never jump by more than 180°, e.g.
 * 179 -> 181 rather than 179 -> -179. Raw coordinates crossing the antimeridian would
 * otherwise draw as a spurious line all the way back across the map.
 */
function unwrapLongitudes(points: Coordinates[]): Coordinates[] {
	const result: Coordinates[] = [points[0]];
	for (let i = 1; i < points.length; i++) {
		result.push({
			latitude: points[i].latitude,
			longitude: longitudeNear(result[i - 1].longitude, points[i].longitude)
		});
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

/**
 * Issue #280: the same Web Mercator this app's basemap uses, in degree units, so a shape
 * drawn as a plain `<svg>` and the same shape drawn by MapLibre curve identically.
 *
 * Latitude is clamped an eighth of a degree short of the projection's own singularity at
 * ±85.051129. Longyearbyen at 78.2°N is the northernmost airport in the dataset, so
 * nothing real comes close; the clamp exists so a bad coordinate produces a squashed
 * picture rather than an `Infinity` that silently voids the whole preview's bounding box.
 */
const MERCATOR_LATITUDE_LIMIT = 85;

export function mercatorY(latitude: number): number {
	const clamped = Math.min(MERCATOR_LATITUDE_LIMIT, Math.max(-MERCATOR_LATITUDE_LIMIT, latitude));
	return (Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) * 180) / Math.PI;
}

/** Where a preview's drawing area starts and stops, in the SVG's own user units. */
export interface PreviewBox {
	width: number;
	height: number;
	/** Blank kept inside every edge, so a stroke and its end dots never clip. */
	padding: number;
}

export interface ProjectedPoint {
	x: number;
	y: number;
}

/**
 * Which rectangle of the world a preview's box shows, in the same longitude frame as the
 * lines drawn on it (`segments.ts`, `singleFrame`).
 *
 * Issue #346 needed this. `projectToBox` fits a route to its own extent and pads it, so a
 * preview's box covers rather more world than the route's bounding box does, and nothing
 * outside this function knew how much. Anything drawn *under* the route has to agree with
 * it to the pixel, and re-deriving the projection at the call site is how two drawings of
 * the same place end up half a degree apart.
 *
 * Four numbers is the whole projection: the map from here to the box is affine, so
 * `x = (longitude - west) / (east - west) * width` and the same in y, downward.
 *
 * `west === east` means the shape had no extent at all — one point, or two that round to
 * the same place. There is no rectangle to speak of, and `land.ts` treats it as such.
 */
export interface PreviewFrame {
	/** Longitude at the box's left and right edges. */
	west: number;
	east: number;
	/** `mercatorY` of the latitude at the box's bottom and top edges. */
	south: number;
	north: number;
}

export interface ProjectedShape {
	/** One SVG path `d` string per input polyline, in input order. */
	paths: string[];
	/** One projected point per input point, in input order. */
	points: ProjectedPoint[];
	/** The piece of the world this box covers, edge to edge, padding included. */
	frame: PreviewFrame;
}

/**
 * Fits polylines and points into a fixed box, aspect preserved and centred.
 *
 * Every preview is scaled to its own content, so a 3 km walk and a 40 km taxi both fill
 * their thumbnail. That is deliberate and it is the one thing these pictures do not say:
 * they answer "what shape is this leg" and never "how far is it". The distance is printed
 * in words by the timeline row next to them, and the dialog draws the leg on a real
 * basemap at a real scale.
 *
 * A shape with no extent in either direction (one point, or two coordinates that round to
 * the same place at this size) collapses to the centre of the box rather than dividing by
 * zero. A dot is the honest picture of a journey that does not move.
 */
export function projectToBox(
	lines: readonly (readonly Coordinates[])[],
	points: readonly Coordinates[],
	box: PreviewBox
): ProjectedShape {
	const projectedLines = lines.map((line) => line.map((c) => ({ x: c.longitude, y: mercatorY(c.latitude) })));
	const projectedPoints = points.map((c) => ({ x: c.longitude, y: mercatorY(c.latitude) }));
	const all = [...projectedLines.flat(), ...projectedPoints];
	if (all.length === 0) {
		return { paths: [], points: [], frame: { west: 0, east: 0, south: 0, north: 0 } };
	}

	let minX = all[0].x;
	let maxX = all[0].x;
	let minY = all[0].y;
	let maxY = all[0].y;
	for (const p of all) {
		minX = Math.min(minX, p.x);
		maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y);
		maxY = Math.max(maxY, p.y);
	}

	const spanX = maxX - minX;
	const spanY = maxY - minY;
	const usableWidth = box.width - box.padding * 2;
	const usableHeight = box.height - box.padding * 2;
	const scale = spanX === 0 && spanY === 0 ? 0 : Math.min(spanX === 0 ? Infinity : usableWidth / spanX, spanY === 0 ? Infinity : usableHeight / spanY);
	const offsetX = (box.width - spanX * scale) / 2;
	const offsetY = (box.height - spanY * scale) / 2;

	// Two decimals is under a tenth of a pixel at every size these previews render at,
	// and it keeps a 65-point great-circle arc from writing a kilobyte of path data into
	// the DOM once per card.
	const round = (n: number) => Math.round(n * 100) / 100;
	const place = (p: ProjectedPoint): ProjectedPoint => ({
		x: round((p.x - minX) * scale + offsetX),
		y: round((maxY - p.y) * scale + offsetY)
	});

	// Where the box's own four edges land, by running `place` backwards. A shape with no
	// extent has `scale === 0` and no rectangle at all, which the frame reports by leaving
	// west equal to east rather than by dividing by it.
	const frame: PreviewFrame =
		scale === 0
			? { west: minX, east: minX, south: minY, north: maxY }
			: {
					west: minX - offsetX / scale,
					east: minX + (box.width - offsetX) / scale,
					south: maxY - (box.height - offsetY) / scale,
					north: maxY + offsetY / scale
				};

	return {
		frame,
		paths: projectedLines.map((line) =>
			line
				.map(place)
				.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`)
				.join('')
		),
		points: projectedPoints.map(place)
	};
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

/**
 * Issue #141: the zoom for a point whose coordinates locate a *city* rather than an
 * address. The stopover with no bed priced is the only one of those: the free time
 * happens somewhere in the connection city, and the only coordinate this app holds for
 * that city is the airport's own (`data/airports.ts`: "OurAirports has no separate city
 * geometry"). Framing that point at `POINT_VIEW_ZOOM` put the runway on screen at street
 * level and called it the stopover, which is the opposite of what the traveller is being
 * sold. Three zoom levels out covers roughly 20 km on a 375px screen and 75 km on a
 * 1280px one, which reaches the city centre for every satellite airport in the dataset
 * without claiming to know where in it the traveller will actually be.
 */
export const CITY_VIEW_ZOOM = 10;

export type MapView =
	| { kind: 'bounds'; bounds: LngLatBounds }
	| { kind: 'point'; center: readonly [number, number]; zoom: number };

/**
 * How the map should frame a segment: a real bounding box for anything spanning real
 * distance, or a fixed close-in zoom for a single waypoint. A zero-area bounding box
 * does not mean "zoom in as far as possible" — it means "there is only one point here".
 */
export function viewForCoordinates(
	points: readonly Coordinates[],
	options?: {
		/** Overrides `POINT_VIEW_ZOOM` for a single-point view, for a coordinate that
		 *  locates something bigger than an address (see `CITY_VIEW_ZOOM`). Ignored when
		 *  the points span real distance, since a bounding box already sizes itself. */
		pointZoom?: number;
	}
): MapView {
	const bounds = boundsOfCoordinates(points);
	const [west, south, east, north] = bounds;
	if (east - west < MIN_BOUNDS_SPAN_DEGREES && north - south < MIN_BOUNDS_SPAN_DEGREES) {
		return {
			kind: 'point',
			center: [(west + east) / 2, (south + north) / 2],
			zoom: options?.pointZoom ?? POINT_VIEW_ZOOM
		};
	}
	return { kind: 'bounds', bounds };
}
