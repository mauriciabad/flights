import type { Airport } from './airport';
import type { LocalDateTime } from './datetime';
import type { Duration } from './duration';
import type { FlightOffer } from './flight-offer';
import type { Location } from './location';
import type { Money } from './money';
import type { Stay } from './stay';
import { costIsUnknown } from './transfer';
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
	 * display code never redoes timezone-aware subtraction itself. */
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
	 * Neither this field nor `transferToHotel`/`transferToConnectionAirport` implies the
	 * other any more: issue #161 gave the transfers a second destination (the city centre)
	 * so they can exist without a bed, and issue #211 stopped deleting a priced bed that no
	 * transfer provider could route to, so a bed can exist without them. `totalPrice`
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
	 * Issue #231: nights the traveller would sleep, not midnights the clock passed. A
	 * window from 11pm to 5am crosses a date boundary and is worth nobody's room rate, so
	 * it reads zero and the card calls it an overnight wait. `algorithm/nights.ts` owns
	 * that rule and the argument for its six-hour floor; `freeTime` above still carries
	 * the real window, so nothing hides the date change from the traveller.
	 *
	 * Issue #105: computed from `freeTime` alone (`algorithm/nights.ts`'s `nightsToPayFor`),
	 * regardless of whether `stay` above is `undefined`. A 12-night stopover is 12
	 * calendar nights whether or not any provider ever priced a bed for it — the
	 * product thesis ("three nights in Vienna for free") has to rank on that fact even
	 * for a search with no stay-provider key configured, which is every first-time
	 * visitor's default state. `stay` being absent means no *priced* bed, never that
	 * the stopover itself didn't happen; `totalPrice` above is what stays honest about
	 * the unpriced part, not this field. */
	nightsInConnection: number;
	/** Issue #106: the party size `totalPrice` was computed for. `outboundFlight.price`
	 * and `onwardFlight.price` each scale to this count through that offer's OWN
	 * `FlightOffer.priceScope` (issue #109, `algorithm/build.ts`'s `scaleFareForParty`) —
	 * never a blanket "multiply every flight price by travellers". That distinction
	 * exists because it is not the same answer for every provider: Ryanair's fare-finder
	 * has no adults parameter at all and always returns one adult's fare (`'per-person'`,
	 * multiply), while Skyscanner's `adults` parameter was measured live returning the
	 * whole party's total already (`'party-total'`, do not multiply again — see
	 * `FlightFarePriceScope`'s own doc comment for the numbers). `stay.pricePerNight` is
	 * deliberately NOT multiplied by this count at all: issue #80/#94's own choice,
	 * documented in `search/resources.ts`, prices a stay as one flat per-night figure for
	 * the whole party (a dorm bed is arguably per-person and a private room is not — an
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
	 * the total.
	 *
	 * Issue #204: it is the sum of the prices this app was actually given, which is not
	 * the same claim as "what the trip costs". Whenever `unpricedTransferLegs` below
	 * returns anything, or `stay` is absent on a stopover that spends a night, this is a
	 * FLOOR and a caller must render it as one. It never absorbs a guess to close the gap.
	 * `algorithm/score.ts` is where an unknown cost is allowed to weigh on a ranking,
	 * with the assumption it makes named and defended there. */
	totalPrice: Money;
	times: ItineraryTimes;
}

/** Which of an itinerary's four ground legs a statement is about, named exactly as the
 * fields above so nothing can map one onto the wrong leg. */
export type ItineraryTransferLeg =
	| 'transferToOriginAirport'
	| 'transferToHotel'
	| 'transferToConnectionAirport'
	| 'transferToDestinationLocation';

/** Trip order, so a caller listing these legs reads them in the order they happen. */
const TRANSFER_LEGS_IN_TRIP_ORDER: readonly ItineraryTransferLeg[] = [
	'transferToOriginAirport',
	'transferToHotel',
	'transferToConnectionAirport',
	'transferToDestinationLocation'
];

/** One leg of a trip that costs a number nobody gave us, paired with the leg itself so a
 * caller can charge it, name it, or count it without looking the transfer up again. */
export interface UnpricedTransfer {
	leg: ItineraryTransferLeg;
	transfer: Transfer;
}

/**
 * The legs of this trip that cost something nobody quoted. Issue #204, and the list that
 * makes `totalPrice`'s incompleteness a thing the app states rather than hides.
 *
 * Derived, never stored. A picker swap (`algorithm/recompute-selection.ts`) and a
 * waiting-time edit (`algorithm/build.ts`) both rebuild an itinerary's transfer legs, and
 * a cached field would have to be recomputed identically in each of those places. This
 * repo has already paid more than once for two code paths disagreeing about one derived
 * number, so there is only ever one path here.
 *
 * Takes the four legs rather than a whole `Itinerary` so a caller can ask about legs it
 * has resolved but not yet assembled into one.
 */
export function unpricedTransferLegs(legs: Pick<Itinerary, ItineraryTransferLeg>): UnpricedTransfer[] {
	const unpriced: UnpricedTransfer[] = [];
	for (const leg of TRANSFER_LEGS_IN_TRIP_ORDER) {
		const transfer = legs[leg];
		if (transfer !== undefined && costIsUnknown(transfer)) unpriced.push({ leg, transfer });
	}
	return unpriced;
}
