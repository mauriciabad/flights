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
	 * never guesses a stay cost when this is `undefined`; a caller must render that
	 * plainly rather than let the total read as complete. `nightsInConnection` below is
	 * NOT gated on this field (issue #105) — a stopover's night count comes from the
	 * flight schedule alone, not from whether a bed got priced for it. */
	stay?: Stay;
	/** Line 49. */
	freeTime: FreeTime;
	/** Line 60: hotel nights, which is not free time divided by 24 — a stopover that
	 * starts and ends on the same calendar day is zero nights even if it runs 20 hours,
	 * and a stay spanning two midnights is two nights even on a short layover.
	 *
	 * Issue #105: computed from `freeTime` alone (`build.ts`'s own `nightsBetween`),
	 * regardless of whether `stay` above is `undefined`. A 12-night stopover is 12
	 * calendar nights whether or not any provider ever priced a bed for it — the
	 * product thesis ("three nights in Vienna for free") has to rank on that fact even
	 * for a search with no stay-provider key configured, which is every first-time
	 * visitor's default state. `stay` being absent means no *priced* bed, never that
	 * the stopover itself didn't happen; `totalPrice` above is what stays honest about
	 * the unpriced part, not this field. */
	nightsInConnection: number;
	/** Issue #106: the party size `totalPrice` was computed for. `outboundFlight.price`
	 * and `onwardFlight.price` are treated as a per-adult fare and multiplied by this
	 * count — confirmed true for Ryanair's fare-finder, the free, no-key provider that
	 * answers most searches (it has no adults/travellers parameter at all and always
	 * returns one lowest single-adult fare, `providers/flights/ryanair-mapper.ts`).
	 * Skyscanner, Kiwi and Flights Sky also send `travellers` upstream as an `adults`
	 * count, but whether *their* returned price already reflects the full party rather
	 * than one adult is not independently verified here — scaling it again would risk
	 * overcounting instead of undercounting. `stay.pricePerNight` is deliberately NOT
	 * multiplied by this: issue #80/#94's own choice, documented in
	 * `search/resources.ts`, prices a stay as one flat per-night figure for the whole
	 * party (a dorm bed is arguably per-person and a private room is not — an
	 * unresolved nuance that choice already accepts). No `TransferProvider` in this
	 * codebase populates `Transfer.price` today (domain/transfer.ts), so there is
	 * nothing yet to scale there either way. */
	travellers: number;
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
