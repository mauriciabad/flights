/**
 * A point on Earth. Brief line 76 ("cheapest hotels/hostels for each connection within
 * 100km") and line 77 (walking/transit/driving times between points) both need
 * coordinates to query providers against.
 */
export interface Coordinates {
	latitude: number;
	longitude: number;
}

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle kilometres between two points.
 *
 * This is a LOWER BOUND on any real journey between them, never the distance a road or a
 * footpath actually covers, and that is exactly what makes it useful before a routing
 * request: if the straight line is already too far, no route can be shorter. Issue #204
 * uses it that way in `providers/transfers/osrm.ts`, to stop asking a shared public
 * routing instance for a 48km walking route it will only refuse.
 *
 * Three other copies of this arithmetic already exist (`stays/distance.ts`,
 * `algorithm/connections.ts`, `providers/stays/agoda-geo.ts`). This is the domain one, so
 * the next module that needs it has somewhere to import from rather than writing a
 * fourth; converging the existing three is its own change and its own risk.
 */
export function greatCircleDistanceKm(from: Coordinates, to: Coordinates): number {
	const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
	const deltaLat = toRadians(to.latitude - from.latitude);
	const deltaLon = toRadians(to.longitude - from.longitude);
	const h =
		Math.sin(deltaLat / 2) ** 2 +
		Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(deltaLon / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const KM_PER_DEGREE_LATITUDE = 110.57;
const KM_PER_DEGREE_LONGITUDE = 111.32;

/**
 * How finely a routed path is worth keeping, as a fraction of its own extent.
 *
 * Nothing in this app draws a leg across more than about 1,200 device pixels: the card's
 * frozen preview is 100 to 320 px wide (`RoutePreview`), and the dialog's MapLibre map
 * frames one leg at desktop width. Detail below the leg's own extent over 1,200 therefore
 * cannot be rendered by anything here, and in a cache with a 5 MB budget shared across
 * every provider it is not free to keep.
 *
 * Relative rather than absolute on purpose. Every preview fits its leg to its own box, so
 * a 1 km walk is drawn at the same size as a 126 km transfer and wants the same *number*
 * of points, not the same metres between them.
 */
const RENDERED_RESOLUTION = 1200;

/**
 * Thins a routed path to the detail something can actually draw, keeping both ends.
 *
 * Ramer-Douglas-Peucker, on a plane tangent at the path's first point: these are road
 * geometries a few kilometres long, where the difference between that and a spherical
 * measure is far below the tolerance being applied.
 *
 * Issue #408 needed this. OSRM's `overview` has three settings and no tolerance, so the
 * choice is between `simplified` (10 points across a 14.5 km airport run, which draws as a
 * zigzag once a preview fits that run to its own window) and `full` (446 points of real
 * road). Measured over eight real airport transfers, caching `full` as it arrives averages
 * 40.4 kB per route against `simplified`'s 1.1 kB, and 120 cached routes would be 92% of
 * the whole cache budget — an eviction that would look to a traveller like the map
 * silently going back to straight lines. Thinned here it is 2.8 kB, and the BCN run keeps
 * 37 points instead of 10.
 */
export function thinRoutePath(path: readonly Coordinates[]): Coordinates[] {
	if (path.length <= 2) return [...path];

	let west = Infinity;
	let east = -Infinity;
	let south = Infinity;
	let north = -Infinity;
	for (const point of path) {
		if (point.longitude < west) west = point.longitude;
		if (point.longitude > east) east = point.longitude;
		if (point.latitude < south) south = point.latitude;
		if (point.latitude > north) north = point.latitude;
	}
	const kx = Math.cos(((south + north) / 2 / 180) * Math.PI) * KM_PER_DEGREE_LONGITUDE;
	const extentKm = Math.max((east - west) * kx, (north - south) * KM_PER_DEGREE_LATITUDE);
	const tolerance = extentKm / RENDERED_RESOLUTION;
	// A path that goes nowhere has no extent to be a fraction of, and every point on it is
	// within any tolerance of the line between its ends. Its two ends are the whole of it.
	if (!(tolerance > 0)) return [path[0], path[path.length - 1]];

	const keep = new Uint8Array(path.length);
	keep[0] = 1;
	keep[path.length - 1] = 1;
	const stack: [number, number][] = [[0, path.length - 1]];
	while (stack.length > 0) {
		const [first, last] = stack.pop() as [number, number];
		const ax = path[first].longitude * kx;
		const ay = path[first].latitude * KM_PER_DEGREE_LATITUDE;
		const dx = path[last].longitude * kx - ax;
		const dy = path[last].latitude * KM_PER_DEGREE_LATITUDE - ay;
		const lengthSquared = dx * dx + dy * dy;
		let worst = 0;
		let index = -1;
		for (let i = first + 1; i < last; i++) {
			const px = path[i].longitude * kx;
			const py = path[i].latitude * KM_PER_DEGREE_LATITUDE;
			const t =
				lengthSquared === 0
					? 0
					: Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
			const distance = Math.hypot(ax + t * dx - px, ay + t * dy - py);
			if (distance > worst) {
				worst = distance;
				index = i;
			}
		}
		if (index !== -1 && worst > tolerance) {
			keep[index] = 1;
			stack.push([first, index], [index, last]);
		}
	}

	const thinned: Coordinates[] = [];
	for (let i = 0; i < path.length; i++) {
		// Five decimals is 1.1 m, which is finer than any tolerance this function applies
		// and about a fifth of the bytes of the six OSRM sends.
		if (keep[i] === 1) {
			thinned.push({
				latitude: Math.round(path[i].latitude * 1e5) / 1e5,
				longitude: Math.round(path[i].longitude * 1e5) / 1e5
			});
		}
	}
	return thinned;
}
