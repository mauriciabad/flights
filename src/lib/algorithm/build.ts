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
	WaitingTimeRule
} from '../domain';
import { DEFAULT_MIN_LAYOVER_TIME_MINUTES, DEFAULT_TRAVELLERS, DEFAULT_WAITING_TIME_RULES } from '../domain';
import { nightsToPayFor } from './nights';

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

/**
 * The true instant a LocalDateTime represents, in epoch milliseconds. Every LocalDateTime
 * already carries the correct UTC offset for that specific wall-clock moment (see
 * domain/datetime.ts), so this needs no timezone database of its own: parse the digits as
 * if they were UTC, then remove the stored offset. Two LocalDateTimes on either side of a
 * DST change carry different `utcOffsetMinutes`, so subtracting their instants (see
 * `minutesBetween`) gains or loses the real hour instead of the naive wall-clock difference.
 */
function toEpochMs(dateTime: LocalDateTime): number {
	const wallClockAsUtcMs = Date.parse(`${dateTime.local}Z`);
	return wallClockAsUtcMs - dateTime.utcOffsetMinutes * 60_000;
}

/** Real elapsed time between two LocalDateTimes, DST-correct per `toEpochMs` above. This is
 * how layover and free time are computed — never by subtracting the `local` strings
 * directly, which is exactly the bug that makes an overnight connection lose an hour.
 * Exported so issue #24's inline waiting-time editor (ItineraryTimeline.svelte) can
 * recompute free time on an edit with the exact same arithmetic that produced it here,
 * rather than a second implementation that could quietly disagree with this one. */
export function minutesBetween(from: LocalDateTime, to: LocalDateTime): Duration {
	return Math.round((toEpochMs(to) - toEpochMs(from)) / 60_000) as Duration;
}

/**
 * Shifts a LocalDateTime by a short local duration — an airport-to-hotel transfer, a
 * pre-boarding buffer — keeping its `timeZone` and `utcOffsetMinutes` unchanged. That is
 * only correct because every duration this is used with (a terminal transfer, a waiting-time
 * buffer) is minutes long and happens well away from the couple of hours around a DST
 * transition; it is not a general "add a duration in this timezone" function. The
 * multi-hour, potentially DST-crossing gap between the two flights is handled the other way
 * round, by subtracting each flight's own already-correct LocalDateTime (`minutesBetween`),
 * never by walking forward minute-by-minute through this one.
 * Exported for the same reason as `minutesBetween` above.
 */
export function addLocalMinutes(dateTime: LocalDateTime, minutes: number): LocalDateTime {
	const shiftedMs = Date.parse(`${dateTime.local}Z`) + minutes * 60_000;
	return {
		local: new Date(shiftedMs).toISOString().slice(0, 19),
		timeZone: dateTime.timeZone,
		utcOffsetMinutes: dateTime.utcOffsetMinutes
	};
}

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
 * Free time is what is left of the layover after both connection-side transfers and the
 * pre-boarding buffer, as the real check-in/check-out datetimes (brief line 59), not only
 * their difference.
 *
 * Issue #161: the two transfers are read on their own, never gated on `stay`. With no bed
 * priced they may still be a real route between the runway and the city centre, and the
 * minutes it takes to get into town come off free time whether or not anyone priced a
 * place to sleep at the other end.
 *
 * Separate from `deriveItinerary` for one caller: `buildItineraries` rejects a pairing
 * whose window is negative before it totals anything, and totalling first would throw on a
 * mixed-currency pairing it was about to discard anyway.
 */
export function deriveFreeTime(parts: ItineraryParts): FreeTime {
	const { transferToHotel, transferToConnectionAirport, connectionWaitingTime } = parts;
	const start = transferToHotel
		? addLocalMinutes(parts.outboundFlight.arrival, transferToHotel.duration)
		: parts.outboundFlight.arrival;
	const end = transferToConnectionAirport
		? addLocalMinutes(parts.onwardFlight.departure, -(transferToConnectionAirport.duration + connectionWaitingTime))
		: addLocalMinutes(parts.onwardFlight.departure, -connectionWaitingTime);
	return { start, end, duration: minutesBetween(start, end) };
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
	const { stay, transferToHotel, transferToConnectionAirport, connectionWaitingTime } = parts;
	const freeTime = deriveFreeTime(parts);

	// Issue #105: nights come from the free-time window alone, never gated on `stay`. A
	// 12-night stopover is 12 nights whether or not a bed ever got priced for it; `stay`
	// being absent only ever affects `totalPrice` below.
	// Issue #231: nights the traveller would SLEEP, not midnights the clock passed. A gap
	// from 11pm to 5am crosses a date boundary and buys nobody a bed.
	// A negative window has no meaningful night count, so it reads zero rather than the
	// backwards number `nightsBetween` would subtract its way to. The caller is told about
	// that window by `freeTime.duration` itself.
	const nightsInConnection = freeTime.duration < 0 ? 0 : nightsToPayFor(freeTime.start, freeTime.end);

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

	const times: ItineraryTimes = {
		inFlight: sumDurations(parts.outboundFlight.duration, parts.onwardFlight.duration),
		// Origin + connection buffers only — deliberately not the layover. See
		// `buildItineraries`'s hard filter and issue #13's "airport waiting time is not
		// layover time".
		airportWaiting: sumDurations(parts.originWaitingTime, connectionWaitingTime),
		free: freeTime.duration,
		total: sumDurations(
			parts.transferToOriginAirport?.duration,
			parts.originWaitingTime,
			parts.outboundFlight.duration,
			transferToHotel?.duration,
			freeTime.duration,
			transferToConnectionAirport?.duration,
			connectionWaitingTime,
			parts.onwardFlight.duration,
			parts.transferToDestinationLocation?.duration
		)
	};

	return { freeTime, nightsInConnection, totalPrice, times };
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
 * Matches every outbound offer against every onward offer that shares its connection
 * airport, and emits one Itinerary per pair that clears the minimum-layover filter and
 * leaves non-negative free time. Order of the result mirrors the order offers were given
 * in — sorting and scoring are issue #14's job (`score.ts`), not this one's.
 */
export function buildItineraries(input: BuildItinerariesInput): Itinerary[] {
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

	for (const outbound of input.outboundOffers) {
		const connectionCode = outbound.arrivalAirport;
		const onwardCandidates = onwardByConnection.get(connectionCode);
		const connectionAirport = input.connectionAirports[connectionCode];
		const resources = input.connectionResources[connectionCode];
		if (!onwardCandidates || !connectionAirport || !resources) continue;

		for (const onward of onwardCandidates) {
			// RULE: layover is the raw gap between the two flights — never the airport
			// waiting-time buffer below. DST-correct because minutesBetween works from each
			// flight's own already-correct LocalDateTime, not from wall-clock subtraction.
			const layover = minutesBetween(outbound.arrival, onward.departure);
			if (layover < minLayoverTime) continue; // hard filter, brief line 37 — never a score penalty

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
			if (deriveFreeTime(parts).duration < 0) continue;

			itineraries.push({
				...parts,
				...deriveItinerary(parts),
				originAirport: input.originAirport,
				originLocation: input.originLocation,
				transferAnchor,
				destinationAirport: input.destinationAirport,
				destinationLocation: input.destinationLocation
			});
		}
	}

	return itineraries;
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
	const parts: ItineraryParts = { ...itinerary, originWaitingTime, connectionWaitingTime };
	return { ...itinerary, ...parts, ...deriveItinerary(parts) };
}
