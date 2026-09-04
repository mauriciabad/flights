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
