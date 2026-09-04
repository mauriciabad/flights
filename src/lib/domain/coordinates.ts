/**
 * A point on Earth. Brief line 76 ("cheapest hotels/hostels for each connection within
 * 100km") and line 77 (walking/transit/driving times between points) both need
 * coordinates to query providers against.
 */
export interface Coordinates {
	latitude: number;
	longitude: number;
}
