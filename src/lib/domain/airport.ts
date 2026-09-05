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
	/**
	 * A point in the middle of the city, when one is known — issue #162.
	 *
	 * Optional, and usually absent. The airport dataset this app ships (OurAirports) has
	 * no city geometry at all, only the runway's, so this field was the airport's own
	 * coordinates for every city in it. Two stay cards measured a hotel against both
	 * points and printed the identical number twice, one line labelled "from the airport"
	 * and the next "from the city centre".
	 *
	 * `data/airport-city-names.ts` `cityCentreOf` fills this in for the hand-checked
	 * airports whose runway genuinely sits somewhere other than the city on the ticket.
	 * Everywhere else it is `undefined`, which is a fact this app knows and must state
	 * rather than paper over: a reader with no city point drops the line, and nothing
	 * substitutes the airport's position for it.
	 */
	coordinates?: Coordinates;
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
	/**
	 * The passenger terminal, when OpenStreetMap has one — issue #341.
	 *
	 * `coordinates` above is the runway reference point, which is where the airport IS and
	 * not where a traveller ever stands. At Gatwick the two are 1.4 km apart with the runway
	 * between them, and a walk measured from the reference point laps the airfield: 1h 13m
	 * where the walk from the North Terminal is 32m. `data/airport-terminals.ts` has the
	 * whole measurement.
	 *
	 * Optional, and absent for about a quarter of the dataset, the same honest `undefined`
	 * `City.coordinates` above uses. A reader with no terminal falls back to `coordinates`,
	 * which is what every reader did before this field existed.
	 */
	terminalCoordinates?: Coordinates;
	city: City;
	country: Country;
	sizeClass: AirportSizeClass;
}

/**
 * Where a ground transfer touches this airport.
 *
 * Every walk, drive, taxi and bus the app plans starts or ends at an airport, and this is
 * the one place that decides which of the airport's two points it starts at. Issue #341:
 * before this, all of them used `coordinates`, so a walk to a hotel 2.5 km away was routed
 * from the middle of the airfield and came back at more than twice its real length.
 *
 * A function rather than each call site writing `terminalCoordinates ?? coordinates`,
 * because the fallback is the whole rule and four copies of it is four chances to forget
 * one. `search/pipeline.ts` has all four.
 */
export function groundTransferPoint(airport: Airport): Coordinates {
	return airport.terminalCoordinates ?? airport.coordinates;
}
