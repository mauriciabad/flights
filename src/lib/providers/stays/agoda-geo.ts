/**
 * Great-circle distance, needed only because Agoda's search has no radius of its own to
 * honour (agoda-client.ts's header explains why this adapter resolves a coordinate to a
 * place name before searching at all). Once Agoda's response comes back with each
 * property's own coordinates, this is how agoda-mapper.ts enforces `StaySearchQuery.radiusKm`
 * itself instead of trusting a query parameter Agoda's API does not have.
 *
 * A local copy rather than an import from src/lib/algorithm/connections.ts: that file's
 * `haversineDistanceKm` is a private, unexported implementation detail of issue #12's
 * connection graph, one layer above providers in this app's dependency direction (algorithm
 * code depends on providers, not the reverse) — reaching into it would be a layering
 * violation for the sake of six lines of maths.
 */

import type { Coordinates } from '../../domain';

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
	return (degrees * Math.PI) / 180;
}

export function haversineDistanceKm(a: Coordinates, b: Coordinates): number {
	const deltaLatitude = toRadians(b.latitude - a.latitude);
	const deltaLongitude = toRadians(b.longitude - a.longitude);
	const lateralFactor =
		Math.sin(deltaLatitude / 2) ** 2 +
		Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(deltaLongitude / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(lateralFactor));
}
