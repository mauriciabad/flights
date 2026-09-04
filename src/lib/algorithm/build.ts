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
	IataAirportCode,
	Itinerary,
	ItineraryTimes,
	LocalDateTime,
	Location,
	Money,
	Stay,
	Transfer,
	WaitingTimeRule
} from '../domain';
import { DEFAULT_MIN_LAYOVER_TIME_MINUTES, DEFAULT_WAITING_TIME_RULES } from '../domain';

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

/**
 * Hotel nights between two LocalDateTimes at the same place, counted the way a front desk
 * would: by calendar dates crossed, never by dividing free time by 24. A 23:00 arrival and
 * an 08:00-next-day departure is one night at nine hours; a stopover that starts and ends on
 * the same calendar date is zero nights even at twenty. Comparing calendar dates directly
 * (ignoring both clock time and UTC offset) is safe here because check-in and check-out are
 * the same place, so both dates are already in that place's own calendar.
 * Exported for the same reason as `minutesBetween` above.
 */
export function nightsBetween(start: LocalDateTime, end: LocalDateTime): number {
	const startDateMs = Date.parse(`${start.local.slice(0, 10)}T00:00:00Z`);
	const endDateMs = Date.parse(`${end.local.slice(0, 10)}T00:00:00Z`);
	return Math.round((endDateMs - startDateMs) / 86_400_000);
}

/** Exported for the same reason as `minutesBetween` above. */
export function sumDurations(...durations: (Duration | undefined)[]): Duration {
	return durations.reduce<number>((total, duration) => total + (duration ?? 0), 0) as Duration;
}

/** Totals Money values that must already share one currency — converting between
 * currencies is out of scope here, left to whichever module normalises provider prices
 * before they reach the builder. Exported for the same reason as `minutesBetween` above. */
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

/** The hotel and the two connection-side transfers already resolved for one candidate
 * connection airport. Fetching these for real is issues #7-#10's job; a connection with no
 * entry here simply never produces an itinerary, since there is nowhere to send the
 * traveller between flights. */
export interface ConnectionResources {
	stay: Stay;
	transferToHotel: Transfer;
	transferToConnectionAirport: Transfer;
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

			// Free time is what is left of the layover after both airport-side transfers
			// and the pre-boarding buffer, expressed as the real hotel check-in/check-out
			// datetimes (brief line 59), not only their difference.
			const freeStart = addLocalMinutes(outbound.arrival, resources.transferToHotel.duration);
			const freeEnd = addLocalMinutes(
				onward.departure,
				-(resources.transferToConnectionAirport.duration + connectionWaitingTime)
			);
			const freeDuration = minutesBetween(freeStart, freeEnd);
			if (freeDuration < 0) continue; // not enough layover for the transfers plus the buffer

			const freeTime = { start: freeStart, end: freeEnd, duration: freeDuration };
			const nightsInConnection = nightsBetween(freeStart, freeEnd);

			const totalPrice = sumMoney(
				outbound.price,
				onward.price,
				nightsInConnection > 0
					? {
							minorUnits: resources.stay.pricePerNight.minorUnits * nightsInConnection,
							currency: resources.stay.pricePerNight.currency
						}
					: undefined,
				resources.transferToHotel.price,
				resources.transferToConnectionAirport.price,
				input.transferToOriginAirport?.price,
				input.transferToDestinationLocation?.price
			);

			const times: ItineraryTimes = {
				inFlight: sumDurations(outbound.duration, onward.duration),
				// Origin + connection buffers only — deliberately not `layover`. See the
				// hard filter above and issue #13's "airport waiting time is not layover
				// time".
				airportWaiting: sumDurations(originWaitingTime, connectionWaitingTime),
				free: freeDuration,
				total: sumDurations(
					input.transferToOriginAirport?.duration,
					originWaitingTime,
					outbound.duration,
					resources.transferToHotel.duration,
					freeDuration,
					resources.transferToConnectionAirport.duration,
					connectionWaitingTime,
					onward.duration,
					input.transferToDestinationLocation?.duration
				)
			};

			itineraries.push({
				originLocation: input.originLocation,
				transferToOriginAirport: input.transferToOriginAirport,
				originAirport: input.originAirport,
				originWaitingTime,
				outboundFlight: outbound,
				transferToHotel: resources.transferToHotel,
				stay: resources.stay,
				freeTime,
				nightsInConnection,
				transferToConnectionAirport: resources.transferToConnectionAirport,
				connectionWaitingTime,
				onwardFlight: onward,
				destinationAirport: input.destinationAirport,
				transferToDestinationLocation: input.transferToDestinationLocation,
				destinationLocation: input.destinationLocation,
				totalPrice,
				times
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
 * Reuses this module's own arithmetic (`addLocalMinutes`, `minutesBetween`, `nightsBetween`,
 * `sumMoney`) rather than a second implementation in the UI layer, so a hand edit can never
 * disagree with how `buildItineraries` would have computed the same itinerary from scratch.
 * Every value this needs (both flights' price/duration, the stay's nightly rate, both
 * connection-side transfers) already lives on the Itinerary itself, so this takes no other
 * input, unlike `buildItineraries`, which needs the wider candidate pool.
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
	// hotel-bound transfer that anchors freeStart.
	const freeStart = addLocalMinutes(itinerary.outboundFlight.arrival, itinerary.transferToHotel.duration);
	const freeEnd = addLocalMinutes(
		itinerary.onwardFlight.departure,
		-(itinerary.transferToConnectionAirport.duration + connectionWaitingTime)
	);
	const freeDuration = minutesBetween(freeStart, freeEnd);
	const freeTime = { start: freeStart, end: freeEnd, duration: freeDuration };
	const nightsInConnection = nightsBetween(freeStart, freeEnd);

	const totalPrice = sumMoney(
		itinerary.outboundFlight.price,
		itinerary.onwardFlight.price,
		nightsInConnection > 0
			? {
					minorUnits: itinerary.stay.pricePerNight.minorUnits * nightsInConnection,
					currency: itinerary.stay.pricePerNight.currency
				}
			: undefined,
		itinerary.transferToHotel.price,
		itinerary.transferToConnectionAirport.price,
		itinerary.transferToOriginAirport?.price,
		itinerary.transferToDestinationLocation?.price
	);

	const times: ItineraryTimes = {
		inFlight: itinerary.times.inFlight,
		airportWaiting: sumDurations(originWaitingTime, connectionWaitingTime),
		free: freeDuration,
		total: sumDurations(
			itinerary.transferToOriginAirport?.duration,
			originWaitingTime,
			itinerary.outboundFlight.duration,
			itinerary.transferToHotel.duration,
			freeDuration,
			itinerary.transferToConnectionAirport.duration,
			connectionWaitingTime,
			itinerary.onwardFlight.duration,
			itinerary.transferToDestinationLocation?.duration
		)
	};

	return {
		...itinerary,
		originWaitingTime,
		connectionWaitingTime,
		freeTime,
		nightsInConnection,
		totalPrice,
		times
	};
}
