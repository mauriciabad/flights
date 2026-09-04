/**
 * Issue #28: what happens the moment a picker's `onselect` fires. Swapping one flight or
 * one transfer leg on an already-built `Itinerary` is a different operation from building
 * one from scratch (`build.ts`'s job): the candidate pool, the connection airport's size
 * class and the origin/connection waiting-time tiers are all already baked into the
 * itinerary the traveller is looking at, and a picker only ever changes one of six fields
 * on it. Reusing `minutesBetween` / `addLocalMinutes` / `nightsBetween` / `sumMoney` /
 * `sumDurations` from `build.ts` keeps this the same DST-correct arithmetic that built the
 * itinerary in the first place, rather than a second implementation that could disagree
 * with it on an overnight connection.
 *
 * Waiting times (`originWaitingTime`, `connectionWaitingTime`) are deliberately carried
 * over unchanged from the itinerary being edited, never re-derived from the new flight's
 * length or the connection airport's size class: that reclassification needs airport data
 * this module is never given (only the two flights and the four transfer legs), and the
 * itinerary timeline's own "edit the waiting-time buffer directly" control already owns
 * changing those numbers on purpose. A picker swap changes *which* flight or transfer is
 * used; it does not silently re-open how long the traveller waits at the gate.
 */

import { addLocalMinutes, minutesBetween, nightsBetween, sumDurations, sumMoney } from './build';
import type { Duration, FlightOffer, Itinerary, ItineraryTimes, Money, Transfer } from '../domain';
import { DEFAULT_MIN_LAYOVER_TIME_MINUTES } from '../domain';

/** Every field a flight or transport picker can replace on one itinerary. All optional:
 * a caller passes only the one field the user actually picked an alternative for. */
export interface SelectionOverrides {
	outboundFlight?: FlightOffer;
	onwardFlight?: FlightOffer;
	transferToOriginAirport?: Transfer;
	transferToHotel?: Transfer;
	transferToConnectionAirport?: Transfer;
	transferToDestinationLocation?: Transfer;
}

export type ItineraryWarningCode = 'layover-too-short' | 'insufficient-connection-time';

/**
 * Issue #28's acceptance criteria, verbatim: "Picking a later outbound flight that breaks
 * the min layover surfaces a clear warning." This is that surface: a warning is data
 * returned alongside the recomputed itinerary, never a thrown error and never a silently
 * dropped selection. The itinerary this module returns still reflects exactly what the
 * traveller picked, impossible or not; a caller decides how loudly to display the warning,
 * but it must never render the trip as if the warning did not exist.
 */
export interface ItineraryWarning {
	code: ItineraryWarningCode;
	message: string;
}

export interface RecomputedSelection {
	itinerary: Itinerary;
	warnings: ItineraryWarning[];
}

/**
 * Applies `overrides` to `itinerary` and recomputes every derived field that could change:
 * free time (real start/end, not only a duration), nights in connection, the itinerary
 * total price and the times breakdown. Never silently drops an impossible result: a
 * layover under `minLayoverTime` or a transfer/waiting-time combination that leaves no free
 * time at all comes back as a `warnings` entry on an itinerary that still reflects the pick.
 */
export function recomputeItinerarySelection(
	itinerary: Itinerary,
	overrides: SelectionOverrides,
	minLayoverTime: Duration = DEFAULT_MIN_LAYOVER_TIME_MINUTES
): RecomputedSelection {
	const outboundFlight = overrides.outboundFlight ?? itinerary.outboundFlight;
	const onwardFlight = overrides.onwardFlight ?? itinerary.onwardFlight;
	const transferToOriginAirport = overrides.transferToOriginAirport ?? itinerary.transferToOriginAirport;
	const transferToHotel = overrides.transferToHotel ?? itinerary.transferToHotel;
	const transferToConnectionAirport =
		overrides.transferToConnectionAirport ?? itinerary.transferToConnectionAirport;
	const transferToDestinationLocation =
		overrides.transferToDestinationLocation ?? itinerary.transferToDestinationLocation;
	// Left exactly as the source itinerary had them. See this file's header for why a
	// picker swap never reclassifies these on its own.
	const { originWaitingTime, connectionWaitingTime } = itinerary;

	const warnings: ItineraryWarning[] = [];

	// RULE mirrors build.ts: layover is the raw flight-to-flight gap, never the airport
	// waiting-time buffer. Here it is checked, not filtered: an itinerary that fails it is
	// still returned, with the warning attached, per this module's whole point.
	const layover = minutesBetween(outboundFlight.arrival, onwardFlight.departure);
	if (layover < minLayoverTime) {
		warnings.push({
			code: 'layover-too-short',
			message:
				`Only ${layover} minute${layover === 1 ? '' : 's'} between the flights, ` +
				`below the ${minLayoverTime}-minute minimum layover.`
		});
	}

	const freeStart = addLocalMinutes(outboundFlight.arrival, transferToHotel.duration);
	const freeEnd = addLocalMinutes(
		onwardFlight.departure,
		-(transferToConnectionAirport.duration + connectionWaitingTime)
	);
	const freeDuration = minutesBetween(freeStart, freeEnd);
	if (freeDuration < 0) {
		warnings.push({
			code: 'insufficient-connection-time',
			message:
				'This connection no longer leaves enough time for the transfers and the ' +
				'waiting-time buffer around the flights: free time would be negative.'
		});
	}

	const freeTime = { start: freeStart, end: freeEnd, duration: freeDuration };
	// A negative gap has no meaningful night count; clamped to 0 rather than handed to
	// `nightsBetween` and left to produce a number nobody asked for, since the accompanying
	// warning above is already what tells the caller this result is not a bookable trip.
	const nightsInConnection = freeDuration < 0 ? 0 : nightsBetween(freeStart, freeEnd);

	const totalPrice: Money = sumMoney(
		outboundFlight.price,
		onwardFlight.price,
		nightsInConnection > 0
			? {
					minorUnits: itinerary.stay.pricePerNight.minorUnits * nightsInConnection,
					currency: itinerary.stay.pricePerNight.currency
				}
			: undefined,
		transferToHotel.price,
		transferToConnectionAirport.price,
		transferToOriginAirport?.price,
		transferToDestinationLocation?.price
	);

	const times: ItineraryTimes = {
		inFlight: sumDurations(outboundFlight.duration, onwardFlight.duration),
		airportWaiting: sumDurations(originWaitingTime, connectionWaitingTime),
		free: freeDuration,
		total: sumDurations(
			transferToOriginAirport?.duration,
			originWaitingTime,
			outboundFlight.duration,
			transferToHotel.duration,
			freeDuration,
			transferToConnectionAirport.duration,
			connectionWaitingTime,
			onwardFlight.duration,
			transferToDestinationLocation?.duration
		)
	};

	return {
		itinerary: {
			...itinerary,
			outboundFlight,
			onwardFlight,
			transferToOriginAirport,
			transferToHotel,
			transferToConnectionAirport,
			transferToDestinationLocation,
			freeTime,
			nightsInConnection,
			totalPrice,
			times
		},
		warnings
	};
}

/**
 * Issue #28: "each showing the DIFFERENCE from the currently selected flight, not just an
 * absolute price... '+€12, 40 minutes later' is the comparison a person actually makes."
 * `departureDeltaMinutes` is that "40 minutes later": real elapsed time between the two
 * departures, DST-correct, positive meaning the alternative leaves later. Price and
 * duration deltas ride along for the same comparison.
 */
export interface FlightDelta {
	/** `undefined` when the two offers are priced in different currencies: a raw
	 * subtraction across currencies would be a nonsense number, not an estimate. */
	priceDeltaMinorUnits?: number;
	currencyMismatch: boolean;
	/** Positive: the alternative departs later than the current selection. */
	departureDeltaMinutes: number;
	/** Positive: the alternative arrives later than the current selection. */
	arrivalDeltaMinutes: number;
	/** Positive: the alternative's flight time is longer (e.g. a layover or a slower
	 * routing), independent of when it departs. */
	durationDeltaMinutes: Duration;
}

export function diffFlightOffers(current: FlightOffer, alternative: FlightOffer): FlightDelta {
	const currencyMismatch = current.price.currency !== alternative.price.currency;
	return {
		priceDeltaMinorUnits: currencyMismatch
			? undefined
			: alternative.price.minorUnits - current.price.minorUnits,
		currencyMismatch,
		departureDeltaMinutes: minutesBetween(current.departure, alternative.departure),
		arrivalDeltaMinutes: minutesBetween(current.arrival, alternative.arrival),
		durationDeltaMinutes: (alternative.duration - current.duration) as Duration
	};
}

/** Same comparison as `FlightDelta`, for a transport picker's alternatives across modes.
 * No departure/arrival delta: a transit `Transfer`'s own schedule (`transitSchedule`) is
 * the meaningful time signal for that mode, not a raw duration diff against, say, a walk. */
export interface TransferDelta {
	priceDeltaMinorUnits?: number;
	currencyMismatch: boolean;
	/** `false` when either side lacks a price at all (walking, or a provider that never
	 * quotes one), distinct from `currencyMismatch`, since AGENTS.md's "say what you do
	 * not know rather than guessing" means "no price data" and "prices don't compare" must
	 * never collapse into the same `undefined`. */
	hasPriceComparison: boolean;
	durationDeltaMinutes: Duration;
}

export function diffTransfers(current: Transfer, alternative: Transfer): TransferDelta {
	const bothPriced = current.price !== undefined && alternative.price !== undefined;
	const currencyMismatch =
		bothPriced && current.price!.currency !== alternative.price!.currency;
	return {
		priceDeltaMinorUnits:
			bothPriced && !currencyMismatch
				? alternative.price!.minorUnits - current.price!.minorUnits
				: undefined,
		currencyMismatch,
		hasPriceComparison: bothPriced,
		durationDeltaMinutes: (alternative.duration - current.duration) as Duration
	};
}
