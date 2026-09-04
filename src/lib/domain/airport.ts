import type { Coordinates } from './coordinates';
import type { IataAirportCode, IsoCountryCode } from './codes';

/**
 * Issue #1: "Airport, City, Country with an IATA code, coordinates, and a size class."
 * Country only carries an identity, not a coordinate: a single point representing an
 * entire country is not meaningful, and every proximity check in the brief (hotels near a
 * connection, transfers to a location) happens at the airport or city level instead.
 */
export interface Country {
	isoCode: IsoCountryCode;
	name: string;
}

/**
 * The city an airport serves, kept separate from Airport mainly so its name, coordinates
 * and country can back the city icon lookup (issue #11: "the airports include icons for
 * the city or country", brief line 70).
 */
export interface City {
	name: string;
	coordinates: Coordinates;
	country: Country;
}

/**
 * Coarse airport size, matching OurAirports' own `type` values (issue #11: "Derive the
 * class from the OurAirports type plus, where available, passenger volume"), because
 * default waiting time and landing-to-transport time both key off it (brief line 39).
 */
export type AirportSizeClass = 'small' | 'medium' | 'large';

/**
 * Issue #1: "Airport, City, Country with an IATA code, coordinates, and a size class.
 * Size drives the default waiting time, so it is domain data, not a display concern."
 * Brief lines 30-31, 38 (origin/destination and connection airports).
 */
export interface Airport {
	iataCode: IataAirportCode;
	/** Issue #11 lists ICAO among the fields kept from the OurAirports source; kept on
	 * the shared type here rather than added later by that issue, since it would
	 * otherwise have to edit a file outside its own scope. */
	icaoCode?: string;
	name: string;
	coordinates: Coordinates;
	city: City;
	country: Country;
	sizeClass: AirportSizeClass;
}
