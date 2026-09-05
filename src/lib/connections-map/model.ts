/**
 * Issue #324: every connection this search considered, as one drawing plus one row of
 * facts each.
 *
 * The owner: **"i would like to be able to see a map with all the connections avilable
 * between two airports with their itineraries marked"**. The results list answers that one
 * card at a time in rank order, so a traveller can read ten cards and still not know
 * whether the eleventh city exists. This module is the whole set at once.
 *
 * ## It states nothing a provider did not say
 *
 * Every number below is copied off an `Itinerary` the pipeline built or off a rule that
 * refused to build one. Nothing is interpolated, averaged or filled in: a connection whose
 * candidate has not finished is `'pending'` and draws no arc, which is a third state and
 * not a quiet synonym for "nothing flies there". The one line on the picture that is not a
 * flight is the great-circle baseline, and it is the same `directLine` `FlightDetour`
 * already draws for the same reason, kept dashed and captioned everywhere it appears.
 *
 * ## Pure, so the numbers are testable without a map
 *
 * No Svelte, no MapLibre, no IndexedDB. `ConnectionsMap` renders what this returns and
 * `ConnectionsMapDialog` writes sentences about it; neither of them computes a distance or
 * decides what a stopover is worth.
 */

import { minutesBetween } from '../algorithm/build';
import type { ConnectionBlock } from '../algorithm/build';
import type {
	Airport,
	Coordinates,
	Duration,
	IataAirportCode,
	Itinerary,
	ItineraryTransferLeg
} from '../domain';
import { greatCircleDistanceKm, unpricedTransferLegs } from '../domain';
import { greatCircleArc, longitudeNear } from '../itinerary-map/geo';
import type { ItineraryGroup, ItineraryResult } from '../search/types';

export type { ConnectionBlock };

/** What a stopover on this map is worth, in the three answers the picture has to keep
 * apart (issue #324) plus the one it must not collapse into them. */
export type ConnectionState =
	/** A pairing exists and every part of its total was quoted. */
	| 'bookable'
	/** A pairing exists and its total is a floor: something on the trip costs a number
	 * nobody gave us. `BookableConnection.unpriced` says which parts. */
	| 'part-priced'
	/** No pairing, and `ConnectionBlock` says which rule refused it. */
	| 'blocked'
	/** This candidate has not finished. Nothing is known yet, which is not the same claim
	 * as knowing nothing flies. */
	| 'pending';

/** Which parts of a trip's total nobody quoted. Empty on a `'bookable'` connection, and
 * the reason a `'part-priced'` one is not one. */
export interface UnpricedParts {
	/** A stopover that spends at least one night with no bed priced for it. A zero-night
	 * change of plane is not unpriced: there is nothing to book. */
	bed: boolean;
	/** Ground legs a router found but nobody put a fare on, named as `Itinerary`'s own
	 * fields so nothing can map one onto the wrong leg. */
	transferLegs: readonly ItineraryTransferLeg[];
}

export interface BookableConnection {
	/** The pairing the results card opens on: this city's shortest, per issue #224. Carried
	 * whole rather than copied field by field, so the panel reads the same object the card
	 * and the timeline read and cannot drift from either. */
	best: ItineraryResult;
	/** Both flights added up. `times.inFlight`, so it is the same number the card prints. */
	flightTime: Duration;
	/** The raw gap between landing and the onward departure, DST-correct via
	 * `minutesBetween`. Not free time, which has the transfers and the boarding buffer
	 * taken out of it. */
	layover: Duration;
	unpriced: UnpricedParts;
	/** How many other pairings through this city the search found. The panel offers them as
	 * a count, not a list: choosing between them is the result card's job. */
	otherPairings: number;
}

/** One connection airport, as the map draws it and the panel describes it. */
export type ConnectionOnMap = {
	airport: Airport;
	/** Origin to connection, then connection to destination. Great-circle, and drawn in the
	 * origin's longitude frame (`longitudeNear`) so a route across the antimeridian draws
	 * as one short hop rather than a line the long way round the planet. */
	arcs: readonly [Coordinates[], Coordinates[]];
	/** Great-circle kilometres this stopover flies beyond the direct line between the two
	 * ends. Never negative: two sides of a spherical triangle are at least the third. */
	extraKm: number;
	/** Rank among the candidates the search considered, 1 for the best. The panel lists in
	 * this order, because it is the order the results list already uses. */
	rank: number;
} & (
	| { state: 'pending' }
	| { state: 'blocked'; block: ConnectionBlock }
	| { state: 'bookable' | 'part-priced'; trip: BookableConnection }
);

export interface ConnectionsMapModel {
	originAirport: Airport;
	destinationAirport: Airport;
	/**
	 * The shortest line that exists between the two end airports, and the one thing on this
	 * picture nobody sells. No carrier flies it and no fare was quoted for it; it is drawn
	 * dashed and named in words wherever it appears, exactly as `FlightDetour` does on the
	 * card. This app has already spent a night removing map lines that implied routes it did
	 * not have.
	 */
	directLine: Coordinates[];
	directKm: number;
	/** `SearchQuery.minLayoverTime`, echoed so the panel can print the rule beside the gap
	 * it measured without reaching for the query. */
	minLayoverTime: Duration;
	connections: ConnectionOnMap[];
}

export interface ConnectionsMapInput {
	originAirport: Airport;
	destinationAirport: Airport;
	minLayoverTime: Duration;
	/** Ranked candidate codes, best first, straight off `SearchSnapshot.candidates`. */
	candidateCodes: readonly IataAirportCode[];
	/** Resolved airport records. A code with no entry is left off the map: a point with no
	 * coordinates cannot be drawn, and inventing one would put a city on screen that this
	 * app cannot place. */
	airports: Readonly<Partial<Record<IataAirportCode, Airport>>>;
	groups: readonly ItineraryGroup[];
	blocked: Readonly<Partial<Record<IataAirportCode, ConnectionBlock>>>;
}

/** Which of an itinerary's totals nobody could quote. Reads the domain's own
 * `unpricedTransferLegs` rather than a second opinion about what "unpriced" means. */
function unpricedPartsOf(itinerary: Itinerary): UnpricedParts {
	return {
		bed: itinerary.nightsInConnection > 0 && itinerary.stay === undefined,
		transferLegs: unpricedTransferLegs(itinerary).map((unpriced) => unpriced.leg)
	};
}

function tripFor(group: ItineraryGroup): BookableConnection {
	const { itinerary } = group.best.score;
	return {
		best: group.best,
		flightTime: itinerary.times.inFlight,
		layover: minutesBetween(itinerary.outboundFlight.arrival, itinerary.onwardFlight.departure),
		unpriced: unpricedPartsOf(itinerary),
		// `variants` includes `best` itself (see `ItineraryGroup`), so the count of OTHERS
		// is one less. Printing `variants.length` here would offer a traveller one more
		// choice of times than the search actually found.
		otherPairings: group.variants.length - 1
	};
}

/**
 * Builds the whole picture from one snapshot's worth of data.
 *
 * Ordering is the snapshot's own candidate ranking rather than anything computed here. The
 * results list is already sorted that way, and a map whose panel disagreed with the list
 * about which stopover is second would make the traveller reconcile two rankings for no
 * gain.
 */
export function buildConnectionsMapModel(input: ConnectionsMapInput): ConnectionsMapModel {
	const origin = input.originAirport.coordinates;
	// Every other longitude on this drawing is expressed relative to the origin's, so a
	// Tokyo to Los Angeles search draws three arcs and a baseline that all agree which side
	// of the antimeridian they are on. `greatCircleArc` does this within one arc; the frame
	// has to be shared to make separate arcs line up with each other.
	const framed = (point: Coordinates): Coordinates => ({
		latitude: point.latitude,
		longitude: longitudeNear(origin.longitude, point.longitude)
	});
	const destination = framed(input.destinationAirport.coordinates);
	const directKm = greatCircleDistanceKm(origin, destination);

	const groupByCode = new Map(input.groups.map((group) => [group.connectionAirportCode, group]));

	const connections: ConnectionOnMap[] = [];
	for (const [index, code] of input.candidateCodes.entries()) {
		const airport = input.airports[code];
		if (!airport) continue;

		const connection = framed(airport.coordinates);
		const shared = {
			airport,
			arcs: [greatCircleArc(origin, connection), greatCircleArc(connection, destination)] as const,
			extraKm: Math.max(
				0,
				greatCircleDistanceKm(origin, connection) + greatCircleDistanceKm(connection, destination) - directKm
			),
			rank: index + 1
		};

		const group = groupByCode.get(code);
		if (group) {
			const trip = tripFor(group);
			const anythingUnpriced = trip.unpriced.bed || trip.unpriced.transferLegs.length > 0;
			connections.push({ ...shared, state: anythingUnpriced ? 'part-priced' : 'bookable', trip });
			continue;
		}

		const block = input.blocked[code];
		connections.push(block ? { ...shared, state: 'blocked', block } : { ...shared, state: 'pending' });
	}

	return {
		originAirport: input.originAirport,
		destinationAirport: input.destinationAirport,
		directLine: greatCircleArc(origin, destination),
		directKm,
		minLayoverTime: input.minLayoverTime,
		connections
	};
}

/** How many connections are in each state, for the one line the dialog opens with. Counted
 * here rather than in the component so the sentence and the picture cannot disagree. */
export function countByState(model: ConnectionsMapModel): Record<ConnectionState, number> {
	const counts: Record<ConnectionState, number> = { bookable: 0, 'part-priced': 0, blocked: 0, pending: 0 };
	for (const connection of model.connections) counts[connection.state] += 1;
	return counts;
}
