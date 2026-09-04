/**
 * Great-circle distance for the two figures issue #27 asks a stay card to show:
 * "distance from the connection airport and from the city centre."
 *
 * A local copy rather than an import from `src/lib/algorithm/connections.ts` (whose own
 * `haversineDistanceKm` is private, and one layer above providers/UI in this app's
 * dependency direction) or `providers/stays/agoda-geo.ts` (issue #10's own copy, made
 * for the same reason - its header calls reaching into `connections.ts` "a layering
 * violation for the sake of six lines of maths"). A third small, pure copy follows the
 * precedent those two already set rather than forcing a shared geo module into
 * existence for one function this component would be the third and smallest consumer of.
 */

import type { Coordinates } from '$lib/domain';

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
	return (degrees * Math.PI) / 180;
}

export function haversineDistanceKm(a: Coordinates, b: Coordinates): number {
	const dLat = toRadians(b.latitude - a.latitude);
	const dLon = toRadians(b.longitude - a.longitude);
	const lat1 = toRadians(a.latitude);
	const lat2 = toRadians(b.latitude);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Formats a distance for the card: metres under 1km with no decimal ("650 m"), one
 * decimal place in km above that ("4.2 km") - a departure-board UI should not imply
 * false precision on what is already an approximation (straight-line, not the actual
 * walking or transit route). */
export function formatDistanceKm(km: number): string {
	if (km < 1) return `${Math.round(km * 1000)} m`;
	return `${km.toFixed(1)} km`;
}
