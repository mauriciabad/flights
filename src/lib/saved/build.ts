/**
 * Turns a live `Itinerary` into the two things the store keeps: the snapshot and one price
 * observation.
 *
 * This is the seam between the two halves of issue #434. The heart on the result card and
 * the recording call on the results page are a separate change, and everything they need
 * is here as a function that takes what a card already holds, so neither half has to know
 * the stored shape. A snapshot assembled by hand at the call site is how the two would
 * drift.
 *
 * The arithmetic is `buildItineraries`' own `scaleFareForParty` and `sumMoney`, for the
 * same reason `components/itinerary-metrics.ts` reuses them: a fare scales to the party by
 * that offer's declared `priceScope` (issue #109), so a hand-rolled "multiply both fares by
 * travellers" is right for a Ryanair leg and wrong for a Skyscanner one, and the parts
 * would not add up to the total stored beside them.
 */

import type { Airport, Itinerary, ItineraryTransferLeg, Money, Transfer } from '$lib/domain';
import { scaleFareForParty, sumMoney } from '$lib/algorithm/build';
import { savedItineraryId } from './storage';
import type {
	PriceObservation,
	SavedFlight,
	SavedGroundLeg,
	SavedItinerary,
	SavedPlace,
	SavedTrip,
	VisitToken
} from './types';

/** Trip order, so the saved legs read in the order they happen. Same list and same order as
 * `domain/itinerary.ts`'s own, which is what a reader comparing the two will check. */
const TRANSFER_LEGS_IN_TRIP_ORDER: readonly ItineraryTransferLeg[] = [
	'transferToOriginAirport',
	'transferToHotel',
	'transferToConnectionAirport',
	'transferToDestinationLocation'
];

function savedFlight(offer: Itinerary['outboundFlight']): SavedFlight {
	return {
		carrier: { iataCode: offer.carrier.iataCode, name: offer.carrier.name },
		flightNumber: offer.flightNumber,
		departureAirport: offer.departureAirport,
		arrivalAirport: offer.arrivalAirport,
		departure: offer.departure,
		arrival: offer.arrival
	};
}

function savedPlace(airport: Airport): SavedPlace {
	return { airport: airport.iataCode, city: airport.city.name };
}

function transferOf(itinerary: Itinerary, leg: ItineraryTransferLeg): Transfer | undefined {
	return itinerary[leg];
}

function savedGroundLegs(itinerary: Itinerary): SavedGroundLeg[] {
	const legs: SavedGroundLeg[] = [];
	for (const leg of TRANSFER_LEGS_IN_TRIP_ORDER) {
		const transfer = transferOf(itinerary, leg);
		if (transfer) legs.push({ leg, mode: transfer.mode });
	}
	return legs;
}

export interface SavedItineraryInput {
	/** Already through `normalizeQuery`, so this trip and the search history agree on how
	 * one search is spelled. */
	query: string;
	itinerary: Itinerary;
	/**
	 * The connection airport, when the page has resolved one.
	 *
	 * The itinerary carries the connection as an IATA code and nothing else
	 * (`domain/itinerary.ts`), and the results page resolves the airport record
	 * asynchronously, so a card can be hearted before it arrives. Absent, the city falls
	 * back to the code, which is exactly what `ResultCard`'s own `connectionLabel` does
	 * rather than print an empty line.
	 */
	connectionAirport?: Airport;
	/**
	 * The visit the heart was pressed in. It seeds the log's first row, so "what it cost
	 * when I saved it" is a fact the list holds from the moment it is saved rather than one
	 * it waits for the next visit to learn.
	 *
	 * That first row is also what makes the results page's own `recordVisit` on this same
	 * visit a no-op: same token, same trip, one price. Pass the page's token, never a fresh
	 * one, or the log gains two rows for one visit.
	 */
	visit: VisitToken;
	savedAt?: number;
}

/** The snapshot, and the price it was saved at. `savedAt` is injectable for the same reason
 * `SearchHistoryStore.record` takes `now`. */
export function buildSavedItinerary({
	query,
	itinerary,
	connectionAirport,
	visit,
	savedAt = Date.now()
}: SavedItineraryInput): SavedItinerary {
	// The connection is where the outbound lands, which is `results/types.ts`'s
	// `connectionAirportCode` and `ItineraryGroup.connectionAirportCode` said a third way.
	// Read off the flight rather than imported, so `$lib/saved` stays clear of the search
	// pipeline: the saved list has to draw with no provider, no key and no network.
	const connectionCode = itinerary.outboundFlight.arrivalAirport;
	const trip: SavedTrip = {
		origin: savedPlace(itinerary.originAirport),
		connection: {
			airport: connectionCode,
			city: connectionAirport?.city.name ?? connectionCode
		},
		destination: savedPlace(itinerary.destinationAirport),
		outboundFlight: savedFlight(itinerary.outboundFlight),
		onwardFlight: savedFlight(itinerary.onwardFlight),
		nightsInConnection: itinerary.nightsInConnection,
		groundLegs: savedGroundLegs(itinerary),
		bed: itinerary.stay
			? {
					propertyName: itinerary.stay.property.name,
					roomKind: itinerary.stay.roomKind,
					rating: itinerary.stay.property.rating
				}
			: undefined,
		travellers: itinerary.travellers
	};
	return {
		id: savedItineraryId(query, connectionCode),
		query,
		savedAt,
		trip,
		prices: [buildPriceObservation({ itinerary, visit, observedAt: savedAt })]
	};
}

export interface PriceObservationInput {
	itinerary: Itinerary;
	visit: VisitToken;
	observedAt?: number;
}

/**
 * One receipt for one visit.
 *
 * Every part is what a provider quoted or nothing at all. The rate-card estimate for an
 * unquoted ride is deliberately left out, on the same grounds `PriceBreakdown` leaves it
 * out of its own total: it is a guess from a table of municipal tariffs, and a guess inside
 * a stored figure becomes a trend line nobody can tell from measured prices.
 */
export function buildPriceObservation({
	itinerary,
	visit,
	observedAt = Date.now()
}: PriceObservationInput): PriceObservation {
	const flights = sumMoney(
		scaleFareForParty(itinerary.outboundFlight, itinerary.travellers),
		scaleFareForParty(itinerary.onwardFlight, itinerary.travellers)
	);

	const stay = itinerary.stay;
	const bed =
		stay && itinerary.nightsInConnection > 0
			? {
					minorUnits: stay.pricePerNight.minorUnits * itinerary.nightsInConnection,
					currency: stay.pricePerNight.currency
				}
			: undefined;

	const quoted = TRANSFER_LEGS_IN_TRIP_ORDER.map(
		(leg) => transferOf(itinerary, leg)?.price
	).filter((price): price is Money => price !== undefined);
	const ground = quoted.length > 0 ? sumMoney(quoted[0], ...quoted.slice(1)) : undefined;

	return {
		observedAt,
		visit,
		nights: itinerary.nightsInConnection,
		flights,
		bed,
		ground,
		total: itinerary.totalPrice
	};
}

/**
 * Counts visits within one page session, so two tokens minted by one tab are never equal.
 *
 * Module-level rather than passed around: a visit is a fact about this tab, and threading a
 * counter through the results page would be a second source of truth for it.
 */
let visits = 0;

/**
 * A token for one visit to one results page. Mint it once when the page loads and hold it;
 * `appendObservation` refuses a second observation carrying the same one.
 *
 * The millisecond plus a counter, with no random part, because the only thing this has to
 * be distinct from is the previous token in this browser. Two tabs opening in the same
 * millisecond mint the same string, and it costs nothing: each tab holds its own copy of
 * the list and compares against its own newest row, so neither refuses the other's write.
 */
export function newVisitToken(now: number = Date.now()): VisitToken {
	visits += 1;
	return `${now.toString(36)}-${visits.toString(36)}`;
}
