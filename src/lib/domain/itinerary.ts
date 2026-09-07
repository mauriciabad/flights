import type { Airport } from './airport';
import type { LocalDateTime } from './datetime';
import type { Duration } from './duration';
import type { FlightOffer } from './flight-offer';
import type { Location } from './location';
import type { Money } from './money';
import type { Stay } from './stay';
import { costIsUnknown, transferChanges } from './transfer';
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
	/**
	 * The connection half of `airportWaiting`, on its own, because it is the half that is
	 * not `connectionWaitingTime`.
	 *
	 * That field is a rule the traveller set: be at the gate at least this long before
	 * boarding. This is what the layover actually leaves them, and issue #368 is the gap
	 * between the two. On the owner's Porto card the last metro that makes a 4:10am deadline
	 * boards at 1:35am and reaches OPO at 2:38am, so the real wait before a 6:10am flight is
	 * 3h 32m against a 2h rule. The timeline row prints this one; the customise panel's
	 * stepper still edits the rule.
	 *
	 * `algorithm/build.ts` derives it as the layover's residual, which is what keeps
	 * `total` below fixed while the pieces inside it move.
	 */
	connectionAirportWaiting: Duration;
	/**
	 * The origin half of `airportWaiting`, on its own, and the same distinction
	 * `connectionAirportWaiting` above draws at the other end of the trip.
	 *
	 * `originWaitingTime` is a rule the traveller set. This is what the ride to the airport
	 * actually leaves them, and issue #399 is the gap between the two. On the owner's own
	 * card the last set of services out of Begur that makes a 3:50am check-in deadline
	 * boards at 8pm and reaches BCN at 11:36pm, so the real wait before a 5:50am flight is
	 * 6h 14m against a 2h rule. The timeline row prints this one; the customise panel's
	 * stepper still edits the rule.
	 */
	originAirportWaiting: Duration;
	/** Mirrors FreeTime.duration for this summary; FreeTime itself carries the real
	 * start/end. Brief line 59. */
	free: Duration;
	/** Door to door: origin location departure to destination location arrival.
	 * Brief line 55: "Time of each part and total." */
	total: Duration;
}

/**
 * Where `transferToHotel` and `transferToConnectionAirport` go, on an itinerary that has
 * them, and why it has none when it does not.
 *
 * `'stay'` is a booked bed's own address. `'city-centre'` is the connection city's
 * hand-checked centre point (`data/airport-city-names.ts`), routed when no bed was priced
 * but the ride into town is still worth knowing about (issue #161).
 *
 * `'unrouted-stay'` is the third case, and the only one that carries no legs at all: a bed
 * nobody has routed to. The search asks OSRM and Transitous about the one property it
 * picks and no other (`search/resources.ts`), so a traveller who picks a different
 * property off the stay list is going somewhere this app has no journey for. Issue #243 is
 * what happened before that state existed: swapping a hotel 2.8 km from the terminal for a
 * hostel 36 km out left `1h 7m`, "Bus, then bus", the same five next departures and the
 * same free-time window on screen, with only the name and the nightly rate replaced.
 */
export type TransferAnchor = 'stay' | 'city-centre' | 'unrouted-stay';

/**
 * Issue #1: "Itinerary — the full chain, exactly the schedule listed in the brief."
 * Field order mirrors the brief's schedule, lines 44-53.
 *
 * Everything the connection itself is made of lives in `ItineraryConnection` below rather
 * than here, because those five fields are the ones that come and go together. They slot
 * into the schedule between `outboundFlight` and `connectionWaitingTime`, which is where a
 * reader following the brief will look for them.
 */
interface ItineraryBase {
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
	/* Lines 48, 50 and 60, the connection itself, are in `ItineraryConnection` below. */
	/** Line 49, and zero-length on a connection the traveller never leaves the airport for
	 * — `ItineraryConnection`'s airside arm carries that gap as `airsideWait` instead, so
	 * this number and `times.free` say the same thing about the same trip. */
	freeTime: FreeTime;
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
	 * nothing yet to scale there either way.
	 *
	 * Issue #344 does scale the one ground figure that exists, and deliberately not into
	 * the total: `Transfer.fareEstimate` is now rated for this many people, because a
	 * meter charges the car and a bus ticket charges the seat and the two were printed
	 * side by side as though they answered the same question. It stays a `FareEstimate`
	 * rather than a `Money`, `costIsUnknown` still returns true for the leg carrying it,
	 * and `totalPrice` above is still only what providers quoted. */
	travellers: number;
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

/**
 * The half of a connection that follows from the two flights and the buffers around them.
 * `algorithm/build.ts` derives this; the bed and the two journeys to it come from the
 * search, and `ItineraryConnection` below is what ties the two halves together.
 */
export type ConnectionSchedule = AirsideSchedule | StopoverSchedule;

interface AirsideSchedule {
	/**
	 * Landing to the onward departure, whole, spent in the terminal. Issue #426.
	 *
	 * Not the same as `times.connectionAirportWaiting` reduced to a duration: the two edges
	 * are what a surface prints ("Waiting at OPO, 9:20pm to 4:10am") and what
	 * `algorithm/nights.ts` reads to say a wait crosses a night.
	 *
	 * `freeTime` on such a trip is an empty window at the landing moment, because none of
	 * this is free. Both numbers agree, which they did not before: the card read
	 * `FREE TIME No full days` beside `AIRPORT WAIT 4h` about one four-hour gap.
	 */
	airsideWait: FreeTime;
	/** Zero, and typed as zero. A trip with a night in it is the other arm. */
	nightsInConnection: 0;
}

interface StopoverSchedule {
	airsideWait?: undefined;
	/** Line 60: hotel nights, which is not free time divided by 24 — a stopover that
	 * starts and ends on the same calendar day is zero nights even if it runs 20 hours,
	 * and a stay spanning two midnights is two nights even on a short layover.
	 *
	 * Issue #231: nights the traveller would sleep, not midnights the clock passed. A
	 * window from 11pm to 5am crosses a date boundary and is worth nobody's room rate, so
	 * it reads zero and the card calls it an overnight wait. `algorithm/nights.ts` owns
	 * that rule and the argument for its six-hour floor. Since issue #426 a count of zero
	 * puts the trip in the airside arm above rather than leaving it here with a bed and two
	 * rides it does not use, so this number is one or more on anything the builder emits.
	 *
	 * It stays a plain `number` rather than a type that excludes zero, because one pick can
	 * still land here at zero: a ride back longer than the layover, which
	 * `recomputeItinerarySelection` returns with an `insufficient-connection-time` warning
	 * rather than reshaping, so the row the traveller is picking in does not vanish under
	 * their hand. Every such trip carries that warning.
	 *
	 * Issue #105: computed from `freeTime` alone (`algorithm/nights.ts`'s `nightsToPayFor`),
	 * regardless of whether `stay` below is `undefined`. A 12-night stopover is 12
	 * calendar nights whether or not any provider ever priced a bed for it — the
	 * product thesis ("three nights in Vienna for free") has to rank on that fact even
	 * for a search with no stay-provider key configured, which is every first-time
	 * visitor's default state. `stay` being absent means no *priced* bed, never that
	 * the stopover itself didn't happen; `totalPrice` is what stays honest about
	 * the unpriced part, not this field. */
	nightsInConnection: number;
}

/**
 * The connection, in the two shapes it can have. Issue #426.
 *
 * The owner, on a card offering him a ride into a city he never reaches:
 *
 * > when a itinerary has 0 nights, the timeline still shows the transport time to the
 * > imaginary hotel that we never go to and also the waiting time at the airport that
 * > we're already at... it makes no sense. when 0 nights we assume the user stays at the
 * > airport, this means that the change has to be codewise, not just in 1 or 2 places.
 *
 * A stopover with no night is not a stay with the nights set to zero. It is a different
 * journey: land, wait in the terminal, board again. So it is a different shape, and the two
 * do not share a field between them that only one of them means.
 *
 * `airsideWait` is the discriminant, and it is present exactly when the traveller never
 * leaves the airport. Narrow on it and TypeScript knows the rest: no bed, neither ride,
 * nothing for an anchor to name, and a night count of zero. Which is the point. Issue #365
 * fixed this at the one call site that built an itinerary, and it came back because two
 * more call sites build one (a waiting-time edit and a picker swap) and neither knew.
 * A screen cannot render a ride that the type will not let anybody put on the object.
 *
 * ## Why the count is not the discriminant
 *
 * `nightsInConnection === 0` is the rule, but a number cannot narrow a union: `0` is
 * assignable to `number`, so a check against it leaves both arms standing and every screen
 * back to remembering the case by hand. The window the traveller actually spends in the
 * terminal has to exist somewhere anyway — `overnightWaitNote` and `waitsOvernight` both
 * need its two edges — so it is the field that says which trip this is.
 */
export type ItineraryConnection =
	| (AirsideSchedule & {
			stay?: undefined;
			transferToHotel?: undefined;
			transferToConnectionAirport?: undefined;
			transferAnchor?: undefined;
	  })
	| (StopoverSchedule & {
			/** Line 48. Present only alongside `stay` — see that field's own doc comment. */
			transferToHotel?: Transfer;
			/** The bed booked for the free-time stretch, or `undefined` when no stay
			 * provider had a key configured, every one errored or was out of quota, or nothing
			 * bookable by this party was found nearby (issue #94). A missing stay is not a
			 * missing itinerary: flights, free time and transfers still stand on their own, per
			 * AGENTS.md ("partial results are the normal case... say what you do not know").
			 * Neither this field nor `transferToHotel`/`transferToConnectionAirport` implies the
			 * other any more: issue #161 gave the transfers a second destination (the city centre)
			 * so they can exist without a bed, and issue #211 stopped deleting a priced bed that no
			 * transfer provider could route to, so a bed can exist without them. `totalPrice`
			 * never guesses a stay cost when this is `undefined`; a caller must render that
			 * plainly rather than let the total read as complete. `nightsInConnection` is
			 * NOT gated on this field (issue #105). */
			stay?: Stay;
			/** Line 50. Present only alongside `stay` — see that field's own doc comment. */
			transferToConnectionAirport?: Transfer;
			/** What the two connection-side legs are journeys to, or why the trip has none.
			 * See `TransferAnchor`. `undefined` when nobody ever routed them: no destination to
			 * route to, or every transfer provider failed. */
			transferAnchor?: TransferAnchor;
	  });

/** The trip a traveller never leaves the connection airport for. */
export type AirsideItinerary = ItineraryBase & Extract<ItineraryConnection, { airsideWait: FreeTime }>;

/** The trip with a stopover in it, whether or not a bed was priced for the stopover. */
export type CityStopoverItinerary = ItineraryBase & Extract<ItineraryConnection, { airsideWait?: undefined }>;

export type Itinerary = AirsideItinerary | CityStopoverItinerary;

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
export function unpricedTransferLegs(legs: Pick<CityStopoverItinerary, ItineraryTransferLeg>): UnpricedTransfer[] {
	const unpriced: UnpricedTransfer[] = [];
	for (const leg of TRANSFER_LEGS_IN_TRIP_ORDER) {
		const transfer = legs[leg];
		if (transfer !== undefined && costIsUnknown(transfer)) unpriced.push({ leg, transfer });
	}
	return unpriced;
}

/**
 * How many times this whole trip makes the traveller change vehicle, door to door. Issue
 * #424.
 *
 * A SUM across the four ground legs, not a maximum. The question the owner asked is how
 * many changes he has to do, and two legs of one change each is two changes with a
 * suitcase in each hand.
 *
 * A leg with no changes concept contributes nothing rather than blocking the answer, so a
 * trip that walks to one bed and taxis to the airport reads `0`. That is the truth about
 * it and it is also what the filter needs: "no changes" has to be a set a walk-and-taxi
 * trip belongs to, or the traveller asking for the easy trips would be shown none of the
 * easiest ones.
 *
 * `undefined` is reserved for the one shape that would be a lie as a zero: a leg whose own
 * mode says `transit` and which carries no ride legs to count. `transitous-mapper.ts`
 * cannot produce that, so reaching it means a cached `Transfer` or a future adapter has a
 * shape nobody here has seen, and reporting it as "no changes" would be this app inventing
 * an answer. AGENTS.md, "When the data is missing": say what you do not know.
 *
 * Derived rather than stored, and taking the four legs rather than a whole `Itinerary`, for
 * the same two reasons `unpricedTransferLegs` above does both.
 */
export function itineraryChanges(legs: Pick<Itinerary, ItineraryTransferLeg>): number | undefined {
	let changes = 0;
	for (const leg of TRANSFER_LEGS_IN_TRIP_ORDER) {
		const transfer = legs[leg];
		if (transfer === undefined) continue;
		const legChanges = transferChanges(transfer.legs);
		if (legChanges === undefined) {
			if (transfer.mode === 'transit') return undefined;
			continue;
		}
		changes += legChanges;
	}
	return changes;
}

/**
 * The legs of this trip that are walked, and therefore cost nothing.
 *
 * `unpricedTransferLegs` above is one half of `costIsUnknown`; this is the other. An
 * absent `Transfer.price` on a walk is a fact the app knows and an absent one on a taxi is
 * a number nobody measured (`transfer.ts`), and a caller that only ever asks the first
 * question can state the second silence but not the first. Every per-leg screen already
 * says "No fare" against a walk and "Price not available" against an unquoted ride
 * (`components/itinerary-timeline-format.ts`). The receipt on the results card had no way
 * to ask, so it said nothing at all about a walked leg, and a trip of three taxis and one
 * walk read as "Ground, 3 rides" with the fourth leg missing from the only place the trip
 * is added up.
 *
 * A walk carrying a price is deliberately not here. Nothing produces one today, and if a
 * provider ever quotes a shuttle as a walk, its money belongs in the priced total rather
 * than in a list whose whole claim is that these legs are free.
 */
export function walkedTransferLegs(legs: Pick<CityStopoverItinerary, ItineraryTransferLeg>): ItineraryTransferLeg[] {
	return TRANSFER_LEGS_IN_TRIP_ORDER.filter((leg) => {
		const transfer = legs[leg];
		return transfer?.mode === 'walk' && transfer.price === undefined;
	});
}
