import type { Airport } from './airport';
import type { LocalDateTime } from './datetime';
import type { Duration } from './duration';
import type { FlightOffer } from './flight-offer';
import type { Location } from './location';
import type { Money } from './money';
import type { Stay } from './stay';
import type { Transfer } from './transfer';

/**
 * Brief line 59: "Free time (from arrival to the hotel in connection to departure from
 * it. include also interval datetimes)" — the real start/end, not only a duration.
 * Interpretation note lines 106-107.
 */
export interface FreeTime {
	start: LocalDateTime;
	end: LocalDateTime;
	/** = end − start, computed once by whoever builds the itinerary (issue #13), so
	 * display code and the comparator never redo timezone-aware subtraction themselves. */
	duration: Duration;
}

/** Brief lines 55-59: the itinerary's time breakdown, reported alongside the total price. */
export interface ItineraryTimes {
	/** Sum of both flights' durations. Brief line 57. */
	inFlight: Duration;
	/** Origin + connection airport waiting time only — never the gap between flights.
	 * Brief line 58; see WaitingTimeRule in waiting-time.ts for why. */
	airportWaiting: Duration;
	/** Mirrors FreeTime.duration for this summary; FreeTime itself carries the real
	 * start/end. Brief line 59. */
	free: Duration;
	/** Door to door: origin location departure to destination location arrival.
	 * Brief line 55: "Time of each part and total." */
	total: Duration;
}

/**
 * Issue #1: "Itinerary — the full chain, exactly the schedule listed in the brief."
 * Field order mirrors the brief's schedule, lines 44-53.
 */
export interface Itinerary {
	/** Line 44. Optional because "Origin location" itself is an optional input
	 * (line 29). */
	originLocation?: Location;
	/** Line 45. Present only alongside originLocation. */
	transferToOriginAirport?: Transfer;
	originAirport: Airport;
	/** Line 46. The pre-flight buffer, not layover time — see WaitingTimeRule. */
	originWaitingTime: Duration;
	/** Line 47 ("Fight" in the brief is a typo for "Flight"). */
	outboundFlight: FlightOffer;
	/** Line 48. Present only alongside `stay` — see that field's own doc comment. */
	transferToHotel?: Transfer;
	/** The bed booked for the free-time stretch below, or `undefined` when no stay
	 * provider had a key configured, every one errored or was out of quota, or nothing
	 * bookable by this party was found nearby (issue #94). A missing stay is not a
	 * missing itinerary: flights, free time and transfers still stand on their own, per
	 * AGENTS.md ("partial results are the normal case... say what you do not know").
	 * `transferToHotel`/`transferToConnectionAirport` are present only alongside this
	 * field — without a bed, there is nowhere for either transfer to go. `totalPrice`
	 * and `nightsInConnection` never guess a stay cost when this is `undefined`; a
	 * caller must render that plainly rather than let the total read as complete. */
	stay?: Stay;
	/** Line 49. */
	freeTime: FreeTime;
	/** Line 60: hotel nights, which is not free time divided by 24 — a stopover that
	 * starts and ends on the same calendar day is zero nights even if it runs 20 hours,
	 * and a stay spanning two midnights is two nights even on a short layover. Always 0
	 * when `stay` is `undefined` — there is no booked bed to count nights against, never
	 * a guess standing in for "unknown". */
	nightsInConnection: number;
	/** Line 50. Present only alongside `stay` — see that field's own doc comment. */
	transferToConnectionAirport?: Transfer;
	/** Line 51. */
	connectionWaitingTime: Duration;
	/** Line 52. */
	onwardFlight: FlightOffer;
	destinationAirport: Airport;
	/** Line 53. Optional because "Destination location" itself is an optional input
	 * (line 32). */
	transferToDestinationLocation?: Transfer;
	destinationLocation?: Location;
	/** Line 54: "Price of each part and in total." Each part's own price already lives
	 * on that part (FlightOffer.price, Transfer.price, Stay.pricePerNight); this is only
	 * the total. */
	totalPrice: Money;
	times: ItineraryTimes;
}
