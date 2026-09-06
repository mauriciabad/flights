/**
 * Issue #13: match outbound offers (origin -> connection) against onward offers
 * (connection -> destination) and emit whole `Itinerary` objects, following the schedule
 * in docs/prompts/001-initial-brief.md lines 44-53.
 *
 * Pure functions only: data in, itineraries out. No network calls, no Svelte. Fetching the
 * flights, stays and transfers this module consumes is other issues' job (#5-#10); picking
 * which connection airports are even worth asking for is the connection graph's (#12).
 */

import type {
	Airport,
	AirportSizeClass,
	Duration,
	FlightLengthClass,
	FlightOffer,
	FreeTime,
	IataAirportCode,
	Itinerary,
	ItineraryTimes,
	LocalDateTime,
	Location,
	Money,
	Stay,
	Transfer,
	TransferAnchor,
	TransitLegField,
	WaitingTimeRule
} from '../domain';
import { DEFAULT_MIN_LAYOVER_TIME_MINUTES, DEFAULT_TRAVELLERS, DEFAULT_WAITING_TIME_RULES } from '../domain';
import { addLocalMinutes, minutesBetween } from './datetime';
import { nightsToPayFor } from './nights';
import { readStaleSchedule, transitLegMoment } from './transit-schedule';

/**
 * The brief ties waiting-time tiers to "short flight or small airport" vs "long flight or
 * large airport" (line 39) but never states the short/long cutoff itself. 3 hours is this
 * module's own choice, not one settled by the brief or the domain model: short-haul flights
 * are almost always well under it, long-haul rarely is. A caller who disagrees is free to
 * supply `waitingTimeRules` keyed only on `airportSize` — `flightLength` on a rule is an
 * optional extra matcher, never a required one.
 */
export const FLIGHT_LENGTH_THRESHOLD_MINUTES = 180 as Duration;

function flightLengthClass(duration: Duration): FlightLengthClass {
	return duration >= FLIGHT_LENGTH_THRESHOLD_MINUTES ? 'long' : 'short';
}

/**
 * Picks the most specific matching rule: the one with the most matcher fields defined,
 * so a flat catch-all (no matchers) loses to a rule that names both `airportSize` and
 * `flightLength`. Ties keep the later entry, matching how DEFAULT_WAITING_TIME_RULES reads
 * as "flat default, then an override for a specific case" rather than requiring rules to be
 * pre-sorted by the caller.
 */
function pickWaitingTime(
	rules: WaitingTimeRule[],
	airportSize: AirportSizeClass,
	flightLength: FlightLengthClass
): Duration {
	let best: WaitingTimeRule | undefined;
	let bestSpecificity = -1;
	for (const rule of rules) {
		const sizeMatches = rule.airportSize === undefined || rule.airportSize === airportSize;
		const lengthMatches = rule.flightLength === undefined || rule.flightLength === flightLength;
		if (!sizeMatches || !lengthMatches) continue;
		const specificity =
			(rule.airportSize === undefined ? 0 : 1) + (rule.flightLength === undefined ? 0 : 1);
		if (specificity >= bestSpecificity) {
			best = rule;
			bestSpecificity = specificity;
		}
	}
	if (!best) {
		throw new Error(
			`No waiting-time rule matches airport size "${airportSize}" and flight length "${flightLength}". Include a catch-all rule with no matchers, as DEFAULT_WAITING_TIME_RULES does.`
		);
	}
	return best.waitingTime;
}

/** Wall-clock arithmetic moved to `datetime.ts` in issue #368, so that
 * `algorithm/transit-schedule.ts` can use it without importing the module that now asks it
 * questions. Still re-exported here: `minutesBetween` and `addLocalMinutes` have been part
 * of this module's surface since issue #13, and issue #24's inline waiting-time editor
 * recomputes free time with the exact same arithmetic that produced it here rather than a
 * second implementation that could quietly disagree with this one. */
export { addLocalMinutes, minutesBetween } from './datetime';

/** Issue #231 moved the two night rules to `nights.ts`, where `recompute-selection.ts` reads
 * them too and where the argument for the six-hour floor can be written down beside the
 * arithmetic it qualifies. Still re-exported here: `nightsBetween` has been part of this
 * module's surface since issue #13. */
export { nightsBetween, nightsToPayFor } from './nights';

/** Exported for the same reason as `minutesBetween` above. */
export function sumDurations(...durations: (Duration | undefined)[]): Duration {
	return durations.reduce<number>((total, duration) => total + (duration ?? 0), 0) as Duration;
}

/** Multiplies a Money value by a positive integer traveller count, rounding to the
 * nearest minor unit. Never call this on a `FlightOffer.price` directly — use
 * `scaleFareForParty` below, which reads the offer's own `priceScope` first. This stays
 * exported for the one price that IS always safe to scale by a plain traveller count
 * regardless of provider (none currently — kept for symmetry with `sumMoney` and in case
 * a future per-traveller, non-flight cost needs the identical rounding rule). */
export function scaleMoney(money: Money, travellers: number): Money {
	return { minorUnits: Math.round(money.minorUnits * travellers), currency: money.currency };
}

/**
 * A `FlightOffer`'s own contribution to a party's total, honouring what that specific
 * offer declares about itself (`FlightOffer.priceScope`, issue #109) rather than a
 * blanket "always multiply by travellers": a `'per-person'` fare (confirmed for Ryanair
 * and Flights Sky, both structurally unable to request more than one adult's price) is
 * multiplied by `travellers`; a `'party-total'` fare (confirmed live for Skyscanner —
 * see `FlightFarePriceScope`'s own doc comment for the measurement) is used as-is,
 * multiplying it again would overcount a group's fare, the worse of the two failure
 * modes. Two legs of the same itinerary can come from different providers with different
 * answers, so this is applied per offer, never once to their sum. Exported for the same
 * reason as `minutesBetween` above. */
export function scaleFareForParty(offer: FlightOffer, travellers: number): Money {
	return offer.priceScope === 'party-total' ? offer.price : scaleMoney(offer.price, travellers);
}

/** Totals Money values that must already share one currency — converting between
 * currencies is out of scope here, left to whichever module normalises provider prices
 * before they reach the builder. Exported for the same reason as `minutesBetween` above.
 *
 * Skipping `undefined` is a deliberate "this part contributed nothing", NOT "this part is
 * free". Issue #204: for a transfer those are opposite claims, and every caller passing a
 * `Transfer.price` here has to say which of the two it left out. See
 * `domain/itinerary.ts`'s `unpricedTransferLegs`, which is what both call sites below
 * hand to the ranking and the card. */
export function sumMoney(first: Money, ...rest: (Money | undefined)[]): Money {
	let total = first.minorUnits;
	for (const part of rest) {
		if (part === undefined) continue;
		if (part.currency !== first.currency) {
			throw new Error(
				`Cannot total a mix of currencies (${first.currency} and ${part.currency}) — currency conversion is out of scope for the itinerary builder.`
			);
		}
		total += part.minorUnits;
	}
	return { minorUnits: total, currency: first.currency };
}

/**
 * The parts of a trip somebody chooses. Everything else about an itinerary follows from
 * these by arithmetic, and `deriveItinerary` below is the only place that arithmetic
 * lives.
 *
 * `Pick<Itinerary, ...>` rather than a shape of its own, so a field can never be named one
 * thing here and another on the itinerary it rebuilds.
 */
export type ItineraryParts = Pick<
	Itinerary,
	| 'outboundFlight'
	| 'onwardFlight'
	| 'originWaitingTime'
	| 'connectionWaitingTime'
	| 'travellers'
	| 'stay'
	| 'transferToOriginAirport'
	| 'transferToHotel'
	| 'transferToConnectionAirport'
	| 'transferToDestinationLocation'
>;

/** What follows from `ItineraryParts`, and nothing an editor is allowed to set by hand. */
export type DerivedItinerary = Pick<Itinerary, 'freeTime' | 'nightsInConnection' | 'totalPrice' | 'times'>;

/**
 * One layover, split into the pieces it is actually made of.
 *
 * The layover itself is fixed the moment the two flights are chosen: landing to the onward
 * departure, and nothing inside it can be longer or shorter than that. What varies is where
 * the traveller spends it, so this names each piece against the clock rather than adding
 * durations up and hoping they land on the same number.
 *
 * Issue #368 is what a sum of parts cost. `free` used to be the check-in deadline minus the
 * ride back, and the row beneath it on the card printed the real last metro, 1h 28m earlier.
 * Both claimed to say when the traveller leaves the hostel. Now the timetable answers, once,
 * and `airportWait` is whatever is left over, which is the piece with no schedule of its own
 * and therefore the honest one to make the residual.
 *
 * `intoTown` and `backToAirport` are measured, not read off `Transfer.duration`. A ride that
 * starts at 7:30am because that is when the coach runs takes 40 minutes longer out of the
 * traveller's day than its 39-minute timetable says, and that difference belongs to the leg
 * rather than being quietly billed to free time.
 */
export interface ConnectionLayover {
	/** Landing to the onward departure. `intoTown + free.duration + backToAirport +
	 * airportWait` is exactly this, always. */
	total: Duration;
	intoTown: Duration;
	free: FreeTime;
	backToAirport: Duration;
	/** When the traveller is back at the connection airport. */
	atAirport: LocalDateTime;
	/** `atAirport` to the onward departure. At least `connectionWaitingTime` when a
	 * timetable made the traveller leave early, exactly it when nothing did. */
	airportWait: Duration;
}

/**
 * The run from the traveller's own door to the outbound flight, split into the pieces it
 * is actually made of. Issue #399, and the same shape as `ConnectionLayover` above.
 *
 * The one difference is what is fixed. A layover is pinned at both ends by flights, so its
 * total cannot move; this leg is pinned at one end only, and when the timetable says the
 * last set of services out of Begur that makes a 3:50am check-in boards at 8pm, the trip
 * really does start at 8pm. `total` moving is the whole point rather than a side effect:
 * the old number began the journey at 12:07am, the check-in deadline minus the ride, and
 * put four hours of the traveller's evening in nothing the card printed.
 */
export interface OriginLeg {
	/** Leaving to the outbound departure. `toAirport + airportWait` is exactly this. */
	total: Duration;
	/** When the traveller leaves. The ride's boarding time where a timetable answered, so
	 * it is the clock the timeline row already prints for that leg and not a second one. */
	departure: LocalDateTime;
	toAirport: Duration;
	/** When the traveller is at the origin airport. */
	atAirport: LocalDateTime;
	/** `atAirport` to the outbound departure. At least `originWaitingTime` when a timetable
	 * made the traveller leave early, exactly it when nothing did. */
	airportWait: Duration;
}

/**
 * When a leg's stored timetable still describes the trip on screen, and may therefore be
 * read as fact.
 *
 * `readStaleSchedule` is the one derivation of that question (`algorithm/transit-schedule.ts`),
 * and it clears itself: drag the connection buffer back to where it was and the leg's moment
 * matches what the lookup was planned for again. A stale timetable is a real answer to a
 * question nobody is asking any more, so the edges fall back to arithmetic until the
 * refetch lands.
 */
function liveSchedule(parts: ItineraryParts, field: TransitLegField) {
	const schedule = parts[field]?.transitSchedule;
	if (!schedule) return undefined;
	// `readStaleSchedule` says `undefined` both for "still applies" and for "cannot say", and
	// the second must not read as the first here. A runway leg with no recorded walk-out has
	// no derivable moment (`transitLegMoment`), so nothing can check its timetable against
	// the trip, and an edge that decides whether a bed gets booked should not rest on one.
	if (!transitLegMoment(parts, field)) return undefined;
	return readStaleSchedule(parts, field) === undefined ? schedule : undefined;
}

/**
 * Free time is what is left of the layover after both connection-side transfers and the
 * pre-boarding buffer, as the real check-in/check-out datetimes (brief line 59), not only
 * their difference.
 *
 * Issue #161: the two transfers are read on their own, never gated on `stay`. With no bed
 * priced they may still be a real route between the runway and the city centre, and the
 * minutes it takes to get into town come off free time whether or not anyone priced a
 * place to sleep at the other end.
 *
 * ## Where each edge comes from. Issue #368
 *
 * A timetable beats the subtraction whenever there is one, because a metro does not leave
 * when the arithmetic would like it to.
 *
 * The closing edge is `TransitSchedule.intended`, the last departure that still makes the
 * check-in deadline. That is the same field the timeline row prints, deliberately: the two
 * were 1h 28m apart on the owner's Porto card and they are one event. `intended` is the
 * boarding time rather than the moment the traveller stands up, so a walk to the stop sits
 * on the free-time side of the edge by a few minutes. Correcting for that would invent a
 * third number for the one event this issue exists to give one number to.
 *
 * The opening edge is `TransitSchedule.arrival`, when the service caught actually reaches
 * the door. Absent, and the arithmetic stands: nobody knows when the traveller gets there,
 * and guessing is worse than the old answer.
 *
 * Both fall back to landing-plus-the-ride and deadline-minus-the-ride for a road leg, which
 * has no timetable and needs none, and for a stale one.
 *
 * Separate from `deriveItinerary` for one caller: `buildItineraries` rejects a pairing
 * whose window is negative before it totals anything, and totalling first would throw on a
 * mixed-currency pairing it was about to discard anyway.
 */
export function deriveFreeTime(parts: ItineraryParts): FreeTime {
	return deriveLayover(parts).free;
}

/** The whole split, for the two surfaces that draw the layover piece by piece rather than
 * only asking what is free: `times` in `deriveFromNights` below, and the trip strip. */
export function deriveLayover(parts: ItineraryParts): ConnectionLayover {
	const { outboundFlight, onwardFlight, transferToHotel, transferToConnectionAirport, connectionWaitingTime } = parts;

	const start =
		liveSchedule(parts, 'transferToHotel')?.arrival ??
		(transferToHotel
			? addLocalMinutes(outboundFlight.arrival, transferToHotel.duration)
			: outboundFlight.arrival);

	const deadline = addLocalMinutes(onwardFlight.departure, -connectionWaitingTime);
	const leaves = liveSchedule(parts, 'transferToConnectionAirport');
	const end =
		leaves?.intended ??
		(transferToConnectionAirport
			? addLocalMinutes(deadline, -transferToConnectionAirport.duration)
			: deadline);

	// The ride back gets the traveller somewhere, and that somewhere is the airport, so the
	// wait after it is whatever the onward flight leaves. `leaves.arrival` is the timetable's
	// own answer; without one the ride is assumed to take exactly as long as it says.
	const atAirport =
		leaves?.arrival ??
		(transferToConnectionAirport ? addLocalMinutes(end, transferToConnectionAirport.duration) : end);

	const free: FreeTime = { start, end, duration: minutesBetween(start, end) };
	return {
		total: minutesBetween(outboundFlight.arrival, onwardFlight.departure),
		intoTown: minutesBetween(outboundFlight.arrival, start),
		free,
		backToAirport: minutesBetween(end, atAirport),
		atAirport,
		airportWait: minutesBetween(atAirport, onwardFlight.departure)
	};
}

/**
 * The origin leg's split, for `times` below and for the trip strip. Issue #399.
 *
 * Both edges come from the same two fields `deriveLayover` reads at the other end, and for
 * the same reasons. `intended` is the departure the traveller is told to catch, and the
 * timeline row beside this prints it, so reading anything else here would be issue #368's
 * two-clocks-for-one-event all over again. `arrival` is when that service reaches the
 * airport, which is the only honest place for the wait to start.
 *
 * `Transfer.duration` is deliberately not the ride's length here. Transitous measures it
 * from the walk to the first stop, 7 minutes before boarding on the owner's own card, and
 * `intended` is the boarding. Preferring `duration` would put a third clock on the leg;
 * this way the seven minutes sit before the trip starts, which is the same rounding
 * `deriveLayover` already accepts at the hostel end.
 */
export function deriveOriginLeg(parts: ItineraryParts): OriginLeg {
	const { outboundFlight, transferToOriginAirport, originWaitingTime } = parts;

	const deadline = addLocalMinutes(outboundFlight.departure, -originWaitingTime);
	const leaves = liveSchedule(parts, 'transferToOriginAirport');
	const departure =
		leaves?.intended ??
		(transferToOriginAirport ? addLocalMinutes(deadline, -transferToOriginAirport.duration) : deadline);
	// Without a timetable the ride is assumed to take exactly as long as it says, which
	// lands the traveller on the deadline: the arithmetic this leg has always used.
	const atAirport =
		leaves?.arrival ??
		(transferToOriginAirport ? addLocalMinutes(departure, transferToOriginAirport.duration) : deadline);

	return {
		total: minutesBetween(departure, outboundFlight.departure),
		departure,
		toAirport: minutesBetween(departure, atAirport),
		atAirport,
		airportWait: minutesBetween(atAirport, outboundFlight.departure)
	};
}

/**
 * Every number an itinerary carries but nobody picks. One implementation, called by all
 * three paths that produce an itinerary: `buildItineraries` from a candidate pool,
 * `recomputeItineraryWaitingTimes` from a hand-edited buffer, and
 * `recomputeItinerarySelection` from a picker swap.
 *
 * Issue #265 is why it exists. `recomputeItinerarySelection` kept a `stay &&` on both
 * edges of the free-time window that `buildItineraries` dropped in #161, so a flight swap
 * on a bedless stopover with a routed ride into town handed back 45 more minutes of free
 * time than the builder had given the identical trip. Copying the condition across would
 * have fixed that instance and left the next divergence to be found by eye; there is now
 * nothing to copy.
 */
export function deriveItinerary(parts: ItineraryParts): DerivedItinerary {
	return deriveFromNights(parts, nightsPaidFor(parts));
}

/**
 * Whether this pairing puts a night in the total.
 *
 * Issue #105: nights come from the free-time window alone, never gated on `stay`. A
 * 12-night stopover is 12 nights whether or not a bed ever got priced for it; `stay` being
 * absent only ever affects `totalPrice`.
 * Issue #231: nights the traveller would SLEEP, not midnights the clock passed. A gap from
 * 11pm to 5am crosses a date boundary and buys nobody a bed.
 * A negative window has no meaningful night count, so it reads zero rather than the
 * backwards number `nightsBetween` would subtract its way to. The caller is told about that
 * window by `freeTime.duration` itself.
 */
function nightsPaidFor(parts: ItineraryParts): number {
	const freeTime = deriveFreeTime(parts);
	return freeTime.duration < 0 ? 0 : nightsToPayFor(freeTime.start, freeTime.end);
}

/** Every derived number, given an already-settled night count. Split out for `deriveTrip`,
 * which has to rebuild a trip after taking a bed off it without re-asking the question that
 * took the bed off. */
function deriveFromNights(parts: ItineraryParts, nightsInConnection: number): DerivedItinerary {
	const { stay, transferToHotel, transferToConnectionAirport } = parts;
	const layover = deriveLayover(parts);
	const originLeg = deriveOriginLeg(parts);
	const freeTime = layover.free;

	// Issue #106/#109: each flight leg scales to the party by its OWN declared `priceScope`
	// (`scaleFareForParty`), never a blanket multiply. The stay's per-night rate is never
	// scaled either way — issue #80/#94's own deliberate flat-per-party choice.
	//
	// Issue #204: the four transfer prices are, today, always `undefined`, because no
	// `TransferProvider` in this codebase quotes a fare. That does not make the legs free,
	// and this total does not pretend it does: `unpricedTransferLegs` names every one of
	// them, `score.ts` charges the ranking for them, and the card prints them as an
	// omission. The number here stays exactly what was quoted, which is the whole reason it
	// can be trusted.
	const totalPrice = sumMoney(
		scaleFareForParty(parts.outboundFlight, parts.travellers),
		scaleFareForParty(parts.onwardFlight, parts.travellers),
		stay && nightsInConnection > 0
			? {
					minorUnits: stay.pricePerNight.minorUnits * nightsInConnection,
					currency: stay.pricePerNight.currency
				}
			: undefined,
		transferToHotel?.price,
		transferToConnectionAirport?.price,
		parts.transferToOriginAirport?.price,
		parts.transferToDestinationLocation?.price
	);

	// Issue #365, the owner on a stopover that books no night: "free time should not be free
	// time, it should become waiting at the airport." Nothing here takes him out of the
	// terminal, so the layover is not time in a city, it is time in a departures hall, and
	// the card was printing AIRPORT WAIT 4h beside a night spent entirely at OPO.
	//
	// Both halves of the condition carry weight. A stopover with a night has somewhere to be
	// whether or not any provider could route the ride there (issue #211's real state: a bed
	// priced, no transfer found), so it keeps its free time. A stopover with a ride into town
	// is issue #161's case, where free time runs from arriving in town to leaving it, and
	// that is true with or without a bed at the end of the ride.
	const staysAirside =
		nightsInConnection === 0 && !transferToHotel && !transferToConnectionAirport;
	const airsideLayover = (staysAirside ? Math.max(0, freeTime.duration) : 0) as Duration;

	const times: ItineraryTimes = {
		inFlight: sumDurations(parts.outboundFlight.duration, parts.onwardFlight.duration),
		// Issue #368 made this the layover's residual rather than `connectionWaitingTime`.
		// The buffer is a minimum the traveller set, and a timetable that puts them back in
		// the terminal at 2:38am for a 6:10am flight has given them 3h 32m of it whatever the
		// rule says. The timeline row and the trip strip both draw this one, between the
		// stopover and the onward flight, so the airside layover below is deliberately not in
		// it: those two surfaces already draw that stretch as its own cell.
		connectionAirportWaiting: layover.airportWait,
		// Issue #399 made this the origin leg's residual, for the reason directly above. The
		// last coach out of Begur that makes a 3:50am check-in puts the traveller at BCN at
		// 11:36pm, so the 2h rule buys them 6h 14m and the row was printing the rule.
		originAirportWaiting: originLeg.airportWait,
		// Both real airport waits, plus a layover the traveller cannot leave the airport for.
		// Deliberately not a layover they can: issue #13's "airport waiting time is not
		// layover time" is about the gap a person spends in a city, and `staysAirside` above
		// is how this tells the two apart.
		airportWaiting: sumDurations(originLeg.airportWait, layover.airportWait, airsideLayover),
		free: (freeTime.duration - airsideLayover) as Duration,
		// Door to door, with the origin leg and the layover each taken whole. Both used to be
		// their pieces added back up, which came to the same number only for as long as the
		// pieces were arithmetic: issue #368 moved the stopover's closing edge to the last
		// service that makes the deadline, and issue #399 moved the start of the journey to
		// the first one the traveller actually boards. Summing would have shortened the trip
		// by 1h 28m while the traveller was still standing in Porto, and started the clock
		// 4h 7m after they left home.
		total: sumDurations(
			originLeg.total,
			parts.outboundFlight.duration,
			layover.total,
			parts.onwardFlight.duration,
			parts.transferToDestinationLocation?.duration
		)
	};

	return { freeTime, nightsInConnection, totalPrice, times };
}

/** What `deriveTrip` hands back: the parts the trip really has, every number that follows
 * from them, and the anchor those parts' two connection-side legs still describe. */
export type DerivedTrip = ItineraryParts &
	DerivedItinerary & {
		/** `undefined` once the two rides come off, for the same reason `pairConnections`
		 * drops it alongside legs discarded for a bed's currency: an anchor for legs this
		 * trip no longer has would outlive the only thing it describes. */
		transferAnchor?: TransferAnchor;
	};

/**
 * The trip a pairing actually is, once it is known whether it books a bed. Issue #365.
 *
 * The owner, on a card offering him a routed, priced, mapped metro ride to a hostel he
 * never checks into:
 *
 * > also eventough there's no hotel night the timelines display the travel time to a hotel
 * > that we don't spend any night (wtf)
 *
 * Measured on production, BCN to BVC via Porto: land OPO 10:17pm, ride 47 minutes to Owls
 * Hostel, sit there with no bed booked, ride back at 1:35am for a 6:10am flight. The app
 * had already worked out there was no bed here, printing "Overnight wait, 4h 26m, too short
 * to be worth a bed" on the same card, and then planned the journey to it anyway.
 *
 * So: a stopover that books no night books no bed, and a trip that books no bed makes no
 * journey to one. `pairConnections` already drops those two legs when a bed is discarded for
 * its currency (issue #152). This is the same rule for the other reason a bed is not booked.
 *
 * ## The rides go and the bed stays, which is not a hedge
 *
 * A `Stay` on an itinerary is a quote this search found near the connection airport. The two
 * transfers are a journey this app planned to it. `totalPrice` has excluded the bed on a
 * nightless stopover since issue #140, and the card says so in as many words: "No night spent
 * here, so there is no bed to price." Nothing about that quote is wrong, and it is what
 * prices the first night the moment the ladder or the flight picker adds one. The plan is the
 * part that had no business existing.
 *
 * ## What this deliberately leaves alone
 *
 * A ride anchored to the city centre rather than to a bed. Issue #161 put it there for the
 * traveller with a long daytime layover and no stay provider configured, and going into town
 * is a real thing they do. `transferAnchor` is what tells the two apart, and `city-centre` is
 * the value that keeps a pairing's legs whatever its night count.
 *
 * ## Why the night count is not asked twice
 *
 * Removing the two legs widens the free-time window by however long they took, and on the
 * Porto pairing that is 1h 54m: enough, on another timetable, to push the window back over
 * `MIN_SLEEPABLE_MINUTES` and have a rebuilt trip claim the night that removing the bed was
 * premised on it not having. So the count settled before the bed came off is the count the
 * trip carries.
 *
 * That is the honest reading rather than a pin. "Would anybody check in for this" was asked
 * and answered on the trip that still had somewhere to check into, and taking the hotel away
 * does not hand the traveller a new place to sleep. What the wider window buys them is more
 * hours in a terminal, which `deriveFromNights` then reports as exactly that.
 */
export function deriveTrip(parts: ItineraryParts, transferAnchor?: TransferAnchor): DerivedTrip {
	const nightsInConnection = nightsPaidFor(parts);
	// "These legs end at a bed" rather than `transferAnchor === 'stay'`. In production the
	// anchor is always set alongside the legs (`search/resources.ts`), but the builder treats
	// it as optional and a pairing that arrives with the legs and no anchor would slip the
	// rule silently, which is the failure mode where a green test has no instrument behind
	// it. `city-centre` is the one anchor that means these legs are not about a bed at all.
	const ridesEndAtABed = parts.stay !== undefined && transferAnchor !== 'city-centre';
	if (nightsInConnection > 0 || !ridesEndAtABed) {
		return { ...parts, ...deriveFromNights(parts, nightsInConnection), transferAnchor };
	}
	const withoutRidesToTheBed: ItineraryParts = {
		...parts,
		transferToHotel: undefined,
		transferToConnectionAirport: undefined
	};
	return {
		...withoutRidesToTheBed,
		...deriveFromNights(withoutRidesToTheBed, nightsInConnection),
		transferAnchor: undefined
	};
}

/**
 * The bed, if one was priced, and the two connection-side transfers already resolved for
 * one candidate connection airport. Fetching these for real is issues #7-#10's job.
 *
 * The two transfers used to be optional strictly alongside `stay`, on the reasoning that
 * without a bed there is nowhere for a hotel-bound transfer to go. Issue #161 found the
 * better destination that reasoning missed: the city centre. Both transfers can now be
 * present with `stay` absent (`transferAnchor === 'city-centre'`), which is the ordinary
 * state of a search with no stay-provider key — every first visit.
 *
 * Issue #211 removed the other half of that invariant. `stay` present with neither
 * transfer is now a real state: a bed a provider quoted a price for, which no transfer
 * provider could find a route to. `resources.ts` used to delete such a bed and report it
 * as never priced, which told the traveller the wrong one of two different answers.
 *
 * Issue #94 still holds otherwise: a connection with no bed reachable produces an
 * itinerary anyway, just one with no bed priced. A connection with no entry in
 * `BuildItinerariesInput.connectionResources` AT ALL is the one case that still drops it —
 * the flights themselves never got as far as being asked about, e.g. no dataset entry for
 * the connection airport.
 */
export interface ConnectionResources {
	stay?: Stay;
	/** Which of the two destinations above these transfers describe, or `undefined` when
	 * there are none. Present so `buildItineraries` can tell "these legs belong to a bed
	 * this itinerary had to discard" from "these legs go into town and stand on their own"
	 * — see its `stayCurrencyMatches` block for the one case where that distinction
	 * decides whether the transfers survive. */
	transferAnchor?: TransferAnchor;
	transferToHotel?: Transfer;
	transferToConnectionAirport?: Transfer;
}

export interface BuildItinerariesInput {
	originAirport: Airport;
	destinationAirport: Airport;
	/** A -> C offers for every candidate connection airport C, in one list, grouped
	 * internally by `arrivalAirport`. */
	outboundOffers: FlightOffer[];
	/** C -> B offers for every candidate connection airport C, in one list, grouped
	 * internally by `departureAirport`. */
	onwardOffers: FlightOffer[];
	/** One Airport record per connection airport code that appears in the offers above.
	 * Needed for its `sizeClass`, since the connection airport itself is never stored on
	 * the resulting Itinerary — only the two flights that touch it are. */
	connectionAirports: Record<IataAirportCode, Airport>;
	/** One resource bundle per connection airport code that appears in the offers above. */
	connectionResources: Record<IataAirportCode, ConnectionResources>;
	originLocation?: Location;
	/** Present only alongside `originLocation`, mirroring `Itinerary` itself. */
	transferToOriginAirport?: Transfer;
	destinationLocation?: Location;
	/** Present only alongside `destinationLocation`, mirroring `Itinerary` itself. */
	transferToDestinationLocation?: Transfer;
	/** Brief line 37. Hard filter — a pair with too little time between flights to
	 * physically make the connection is dropped, never merely scored down. Default
	 * DEFAULT_MIN_LAYOVER_TIME_MINUTES. */
	minLayoverTime?: Duration;
	/** Brief line 39. Default DEFAULT_WAITING_TIME_RULES. */
	waitingTimeRules?: WaitingTimeRule[];
	/** Brief line 33, threaded down for issue #106's flight-price scaling — see
	 * `Itinerary.travellers`'s own doc comment for exactly what this does and does not
	 * scale. Default DEFAULT_TRAVELLERS. */
	travellers?: number;
}

/**
 * Why one connection airport ended up with no bookable pairing (issue #324).
 *
 * The traveller's question on a map of stopovers is not "did this one work" but "what
 * would have to change for it to". Those are different answers and this app already knows
 * which: nothing flies onward is a fact about the route, an onward flight that leaves
 * before the inbound lands is a fact about the timetable, and a gap shorter than
 * `minLayoverTime` is a fact about a number the traveller typed and can retype. Collapsing
 * the three into "no viable combination" hides the only one they can act on.
 *
 * A discriminated union rather than a reason string plus optional numbers, because the
 * numbers are not optional per reason: a layover measurement is meaningless on a
 * connection nothing flies out of, and a UI holding `closestLayover` for that case would
 * be printing a zero it invented.
 */
export type ConnectionBlock =
	/** No dataset entry for the airport, so nowhere to send anybody. Not a fact about
	 * flying: it is this app saying it does not know the place. */
	| { reason: 'airport-unknown' }
	| { reason: 'no-outbound-flight' }
	| { reason: 'no-onward-flight' }
	/** Two of this candidate's own parts were quoted in currencies that cannot be added,
	 * so no total could be stated. `SearchDependencies.currency` asks every provider for
	 * the same one, which is what makes this rare. */
	| { reason: 'prices-disagree' }
	/** Every onward flight leaves before the inbound lands. `closestLayover` is the least
	 * negative gap, so "the nearest onward flight goes 40 minutes before you land". */
	| { reason: 'onward-before-arrival'; closestLayover: Duration; minLayoverTime: Duration }
	/** A gap exists but none of them reaches the traveller's own minimum. */
	| { reason: 'layover-under-minimum'; closestLayover: Duration; minLayoverTime: Duration }
	/** The gap clears `minLayoverTime` and still leaves no free time, because getting into
	 * town, back out, and checked in for the onward flight costs more minutes than the
	 * layover has. `groundTimeNeeded` is that cost, so the two numbers can be printed
	 * against each other. */
	| { reason: 'layover-under-ground-time'; closestLayover: Duration; groundTimeNeeded: Duration }
	/** Issue #359: a source had a priced, numbered flight on the day and this app could not
	 * date it, for want of a time zone for the airport. Like `airport-unknown` this is this
	 * app saying what it does not know, and unlike `no-outbound-flight` it is not a claim
	 * that nothing flies. */
	| { reason: 'timezone-unknown' };

/** How near a refusal came to being a trip. A pairing that missed by a rule further down
 * this list is a better explanation than one that missed at the top, so the closest miss
 * is the one reported: a traveller reading "the gap is 25 minutes, your minimum is 30"
 * learns something that "nothing flies onward" would have hidden. */
const BLOCK_CLOSENESS: Record<ConnectionBlock['reason'], number> = {
	'airport-unknown': 0,
	// Issue #359 sits at the "this app's own gap" end of the list, next to `airport-unknown`
	// and for the same reason: if some other pairing through this airport missed on a
	// routing rule, that measurement is the better sentence to print. `closerBlock` never
	// actually arbitrates this one, because `pairConnections` cannot produce it —
	// `processCandidate` decides it before any pairing exists.
	'timezone-unknown': 1,
	'prices-disagree': 2,
	'no-outbound-flight': 3,
	'no-onward-flight': 4,
	'onward-before-arrival': 5,
	'layover-under-minimum': 6,
	'layover-under-ground-time': 7
};

/** Keeps the closest miss, and among two misses of the same kind the one with the longest
 * gap, which is the pairing that came nearest to working. */
function closerBlock(current: ConnectionBlock | undefined, candidate: ConnectionBlock): ConnectionBlock {
	if (!current) return candidate;
	const difference = BLOCK_CLOSENESS[candidate.reason] - BLOCK_CLOSENESS[current.reason];
	if (difference !== 0) return difference > 0 ? candidate : current;
	if ('closestLayover' in candidate && 'closestLayover' in current) {
		return candidate.closestLayover > current.closestLayover ? candidate : current;
	}
	return current;
}

export interface ConnectionPairings {
	/** Order mirrors the order offers were given in. Sorting and scoring are `score.ts`'s
	 * job, not this one's. */
	itineraries: Itinerary[];
	/** One entry per airport in `connectionAirports` that produced no itinerary at all. A
	 * connection that produced even one is absent from here. */
	blocked: Partial<Record<IataAirportCode, ConnectionBlock>>;
}

/**
 * Matches every outbound offer against every onward offer that shares its connection
 * airport, emits one Itinerary per pair that clears the minimum-layover filter and leaves
 * non-negative free time, and says why for every connection that emitted none.
 *
 * The reasons come from the loop that refuses the pairings rather than from a second pass
 * over the same offers. That is the whole point of putting them here: a separate
 * `whyNothingWorked` reading the same inputs would agree with this function exactly once,
 * on the day it was written, and disagree quietly the first time either rule moved.
 */
export function pairConnections(input: BuildItinerariesInput): ConnectionPairings {
	const minLayoverTime = input.minLayoverTime ?? DEFAULT_MIN_LAYOVER_TIME_MINUTES;
	const waitingTimeRules = input.waitingTimeRules ?? DEFAULT_WAITING_TIME_RULES;
	const travellers = input.travellers ?? DEFAULT_TRAVELLERS;

	const onwardByConnection = new Map<IataAirportCode, FlightOffer[]>();
	for (const onward of input.onwardOffers) {
		const existing = onwardByConnection.get(onward.departureAirport);
		if (existing) existing.push(onward);
		else onwardByConnection.set(onward.departureAirport, [onward]);
	}

	const itineraries: Itinerary[] = [];
	const blocked: Partial<Record<IataAirportCode, ConnectionBlock>> = {};
	const paired = new Set<IataAirportCode>();

	/** Records a refusal against the connection it happened at, keeping the closest one. */
	function refuse(code: IataAirportCode, block: ConnectionBlock): void {
		blocked[code] = closerBlock(blocked[code], block);
	}

	// Every connection starts refused for having nothing arriving at it, and the loop below
	// overwrites that the moment an outbound offer names it. Starting from the airports the
	// caller asked about, rather than from the offers, is what lets a connection nobody
	// flies to appear on a map at all: it has no offers to iterate over, so a loop driven by
	// offers alone would never mention it.
	for (const code of Object.keys(input.connectionAirports) as IataAirportCode[]) {
		refuse(code, { reason: 'no-outbound-flight' });
	}

	for (const outbound of input.outboundOffers) {
		const connectionCode = outbound.arrivalAirport;
		const connectionAirport = input.connectionAirports[connectionCode];
		const resources = input.connectionResources[connectionCode];
		if (!connectionAirport || !resources) continue;

		const onwardCandidates = onwardByConnection.get(connectionCode);
		if (!onwardCandidates) {
			refuse(connectionCode, { reason: 'no-onward-flight' });
			continue;
		}

		for (const onward of onwardCandidates) {
			// RULE: layover is the raw gap between the two flights — never the airport
			// waiting-time buffer below. DST-correct because minutesBetween works from each
			// flight's own already-correct LocalDateTime, not from wall-clock subtraction.
			const layover = minutesBetween(outbound.arrival, onward.departure);
			if (layover < minLayoverTime) {
				// hard filter, brief line 37 — never a score penalty
				refuse(connectionCode, {
					reason: layover < 0 ? 'onward-before-arrival' : 'layover-under-minimum',
					closestLayover: layover,
					minLayoverTime
				});
				continue;
			}

			const originWaitingTime = pickWaitingTime(
				waitingTimeRules,
				input.originAirport.sizeClass,
				flightLengthClass(outbound.duration)
			);
			const connectionWaitingTime = pickWaitingTime(
				waitingTimeRules,
				connectionAirport.sizeClass,
				flightLengthClass(onward.duration)
			);

			// Issue #94: `resources.stay` is optional, and an itinerary with no bed priced is
			// still a real itinerary.
			// Issue #161: the two connection-side transfers are NOT gated on the bed any
			// more. With no stay they may still be a real route between the runway and the
			// city centre, and free time then runs from arriving in town to leaving it,
			// which is the honest reading of "six free days in Bergamo". They are dropped
			// only when they were routed to a bed this itinerary has just had to discard for
			// the currency reason below: those two legs end at an address that is no longer
			// part of this trip.
			// Issue #152: a stay quoted in a currency this itinerary cannot total loses the
			// BED, never the trip. `sumMoney` below refuses to add a mix and throws, and the
			// only thing catching that was `pipeline.ts`, which discarded the entire
			// candidate — so an itinerary was destroyed by the one thing it was supposed to
			// achieve, having priced a bed, while every bedless itinerary survived to be
			// rendered under "No bed priced for this stopover." Degrading to no bed is the
			// same outcome as never finding one, which this builder already handles
			// everywhere below.
			//
			// `resources.ts` already filters mismatched stays out a layer up. This is the
			// belt to that braces: the failure mode is silent, total, and will recur with
			// any future provider that ignores a requested currency, so the builder refuses
			// to depend on an upstream filter staying correct.
			const outboundCurrency = outbound.price.currency;
			const stayCurrencyMatches = resources.stay?.pricePerNight.currency === outboundCurrency;
			const stay = stayCurrencyMatches ? resources.stay : undefined;
			const keepConnectionTransfers = resources.transferAnchor === 'city-centre' || stay !== undefined;
			const transferToHotel = keepConnectionTransfers ? resources.transferToHotel : undefined;
			const transferToConnectionAirport = keepConnectionTransfers
				? resources.transferToConnectionAirport
				: undefined;
			// Carried onto the itinerary (issue #243) so every surface that renders one can
			// tell whose journey those two legs are. Dropped alongside the legs themselves:
			// an anchor for transfers this itinerary discarded would outlive the only thing
			// it describes.
			const transferAnchor = keepConnectionTransfers ? resources.transferAnchor : undefined;

			const parts: ItineraryParts = {
				outboundFlight: outbound,
				onwardFlight: onward,
				originWaitingTime,
				connectionWaitingTime,
				travellers,
				stay,
				transferToOriginAirport: input.transferToOriginAirport,
				transferToHotel,
				transferToConnectionAirport,
				transferToDestinationLocation: input.transferToDestinationLocation
			};
			// Not enough layover for the transfers plus the buffer. Asked before
			// `deriveItinerary` totals anything, so a discarded pairing is never summed.
			if (deriveFreeTime(parts).duration < 0) {
				refuse(connectionCode, {
					reason: 'layover-under-ground-time',
					closestLayover: layover,
					groundTimeNeeded: sumDurations(
						transferToHotel?.duration,
						transferToConnectionAirport?.duration,
						connectionWaitingTime
					)
				});
				continue;
			}

			paired.add(connectionCode);
			itineraries.push({
				// Issue #365: `deriveTrip`, not `deriveItinerary`, because a pairing that turns
				// out to book no night has no bed and therefore no rides to one.
				...deriveTrip(parts, transferAnchor),
				originAirport: input.originAirport,
				originLocation: input.originLocation,
				destinationAirport: input.destinationAirport,
				destinationLocation: input.destinationLocation
			});
		}
	}

	for (const code of paired) delete blocked[code];
	return { itineraries, blocked };
}

/** `pairConnections` without the refusals. Every caller that only wants the trips, which
 * is every caller but the connections map, reads this. */
export function buildItineraries(input: BuildItinerariesInput): Itinerary[] {
	return pairConnections(input).itineraries;
}

/** Either buffer, in minutes. Omitting one leaves that side of the itinerary untouched. */
export interface WaitingTimeOverrides {
	originWaitingTime?: Duration;
	connectionWaitingTime?: Duration;
}

/**
 * Issue #24: "Airport waiting times editable inline, with every affected total
 * recomputing" (brief lines 39 and 69, called out twice). Takes an already-built Itinerary
 * plus a hand-edited waiting time on either side and returns a new Itinerary with every
 * dependent field recomputed. It never leaves a partial patch that skips one total.
 *
 * Goes through `deriveItinerary` rather than a second implementation in the UI layer, so
 * a hand edit can never disagree with how `buildItineraries` would have computed the same
 * itinerary from scratch. Every value this needs (both flights' price/duration/priceScope
 * and the party size they're scaled by, the stay's nightly rate, both connection-side
 * transfers) already lives on the Itinerary itself, so this takes no other input, unlike
 * `buildItineraries`, which needs the wider candidate pool.
 *
 * `originWaitingTime` only ever affects `airportWaiting` and `total`: it is time spent
 * before a flight whose schedule is already fixed, so it cannot move anything else.
 * `connectionWaitingTime` additionally shifts `freeTime.end` backward (the buffer eats into
 * the same layover free time draws from), which is why `nightsInConnection` and the
 * nights-priced part of `totalPrice` can also change. `total` stays put when only
 * `connectionWaitingTime` moves: the free-time minutes it removes are exactly the minutes
 * `airportWaiting` gains, since both are carved from one fixed layover.
 */
export function recomputeItineraryWaitingTimes(
	itinerary: Itinerary,
	overrides: WaitingTimeOverrides
): Itinerary {
	const originWaitingTime = overrides.originWaitingTime ?? itinerary.originWaitingTime;
	const connectionWaitingTime = overrides.connectionWaitingTime ?? itinerary.connectionWaitingTime;

	if (
		originWaitingTime === itinerary.originWaitingTime &&
		connectionWaitingTime === itinerary.connectionWaitingTime
	) {
		return itinerary; // nothing actually changed, so skip rebuilding every derived field
	}

	// RULE: free time's start never moves on this edit. Only originWaitingTime or
	// connectionWaitingTime changed, and neither touches the outbound arrival or the
	// hotel-bound transfer that anchors it. `deriveItinerary` is the same arithmetic
	// `buildItineraries` ran, so an edit here cannot disagree with the value it recomputes.
	//
	// Issue #365 stops at `deriveTrip`, deliberately: this edit applies a number the
	// traveller typed, and an edit that answered by deleting one of their transfer legs
	// would be the app taking a decision back. Planning no ride to a bed is the planner's
	// job, and `pairConnections` is where it happens.
	const parts: ItineraryParts = { ...itinerary, originWaitingTime, connectionWaitingTime };
	return { ...itinerary, ...parts, ...deriveItinerary(parts) };
}
