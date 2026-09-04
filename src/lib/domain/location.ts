import type { Coordinates } from './coordinates';

/**
 * A place that is not a curated Airport/City record from the airport dataset: the
 * traveller's actual starting or ending point, used only to price the first and last
 * transfer leg.
 *
 * Brief lines 29 & 32: "Origin location (optional)" / "Destination location (optional)",
 * kept distinct from "Origin airport" / "Destination airport" (lines 30-31) and from the
 * algorithm's "from origin location to airport" / "from destination airport to location"
 * (lines 80-81). Deliberately its own type rather than reusing City: a traveller's actual
 * address is not a curated dataset entry and has no IATA code or size class.
 */
export interface Location {
	label: string;
	coordinates: Coordinates;
}
