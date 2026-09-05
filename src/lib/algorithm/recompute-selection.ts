/**
 * Issue #28: what happens the moment a picker's `onselect` fires. Swapping one flight or
 * one transfer leg on an already-built `Itinerary` is a different operation from building
 * one from scratch (`build.ts`'s job): the candidate pool, the connection airport's size
 * class and the origin/connection waiting-time tiers are all already baked into the
 * itinerary the traveller is looking at, and a picker only ever changes one flight, one
 * transfer leg, or (issue #243) the bed and the two legs that reach it.
 * What changes is which parts the trip is made of. Everything that follows from them —
 * the free-time window, the nights, the total, the times breakdown — comes back from
 * `build.ts`'s `deriveItinerary`, the one implementation the builder itself runs. This
 * module used to hold a second copy of that arithmetic, and issue #265 is what a second
 * copy costs: it kept a `stay &&` on both edges of the free-time window that
 * `buildItineraries` dropped in #161, so a flight swap on a bedless stopover with a routed
 * ride into town reported free time the builder had never given it.
 *
 * Waiting times (`originWaitingTime`, `connectionWaitingTime`) are deliberately carried
 * over unchanged from the itinerary being edited, never re-derived from the new flight's
 * length or the connection airport's size class: that reclassification needs airport data
 * this module is never given (only the two flights and the four transfer legs), and the
 * itinerary timeline's own "edit the waiting-time buffer directly" control already owns
 * changing those numbers on purpose. A picker swap changes *which* flight or transfer is
 * used; it does not silently re-open how long the traveller waits at the gate.
 */

import { deriveItinerary, minutesBetween, type ItineraryParts } from './build';
import type { Duration, FlightOffer, Itinerary, Stay, Transfer, TransferAnchor } from '../domain';
import { DEFAULT_MIN_LAYOVER_TIME_MINUTES } from '../domain';

/**
 * Issue #243: a bed and the two journeys that reach it, picked together.
 *
 * The stay picker used to be the one edit that bypassed this module, on the reasoning that
 * only the price changes when you book a different room. That is true of a different room
 * and false of a different building. `transferToHotel` and `transferToConnectionAirport`
 * are routes to one address, and the free-time window is measured from when they get you
 * there, so a swap that replaced the name alone left a 36 km hostel showing the 1h 7m bus
 * ride computed for a hotel 2.8 km from the terminal.
 *
 * Both transfers arrive together, because one routing produces both. Absent means nobody
 * has routed to this address: the search only ever routes to the property it picks itself,
 * so every other property on the list starts here, and the itinerary comes back with both
 * legs gone and `transferAnchor: 'unrouted-stay'` rather than wearing the previous bed's.
 */
export interface StaySelection {
	/** The property picked, or `undefined` for a trip with no bed priced. */
	stay?: Stay;
	transferToHotel?: Transfer;
	transferToConnectionAirport?: Transfer;
}

/** Every field a flight or transport picker can replace on one itinerary. All optional:
 * a caller passes only the one field the user actually picked an alternative for. */
export interface SelectionOverrides {
	outboundFlight?: FlightOffer;
	onwardFlight?: FlightOffer;
	transferToOriginAirport?: Transfer;
	transferToHotel?: Transfer;
	transferToConnectionAirport?: Transfer;
	transferToDestinationLocation?: Transfer;
	/** Issue #243's stay swap. It owns `stay` and both connection-side transfers together,
	 * so the two `transfer*` fields above stay what they always were: a transport swap on
	 * the bed the itinerary already has. No caller passes both, and this one wins if one
	 * ever does. */
	staySelection?: StaySelection;
}

/** `'stay'` once something has routed to the picked property, `'unrouted-stay'` while
 * nothing has. Both legs come from one routing, so the hotel-bound one answers for the
 * pair. No bed picked leaves no in-city legs and nothing for an anchor to name. */
function anchorForStaySelection(selection: StaySelection): TransferAnchor | undefined {
	if (!selection.stay) return undefined;
	return selection.transferToHotel ? 'stay' : 'unrouted-stay';
}

export type ItineraryWarningCode =
	| 'layover-too-short'
	| 'flights-out-of-order'
	| 'insufficient-connection-time';

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
 * Whether a warning still leaves a journey, or takes the last one away.
 *
 * Two of the three are measured against numbers the traveller chose and can move without
 * leaving the panel the warning is printed on. `layover-too-short` is measured against
 * their own minimum layover; `insufficient-connection-time` against their own waiting-time
 * buffer and the ground legs they can swap two rows up. Both describe a trip that exists
 * and is tight, so both keep their price.
 *
 * `flights-out-of-order` is not that. It is two clock readings subtracted, the onward
 * flight leaving before this one lands, and nothing on this screen moves it. The traveller
 * has to pick a different onward flight or a longer stopover first, and until they do,
 * every number derived from the pairing is a number about a trip nobody can take.
 *
 * A `Record` rather than a list, so adding a fourth code is a compile error here rather
 * than a row that quietly starts pricing itself again.
 */
const WARNING_LEAVES_A_JOURNEY: Record<ItineraryWarningCode, boolean> = {
	'layover-too-short': true,
	'insufficient-connection-time': true,
	'flights-out-of-order': false
};

/**
 * Issue #317: true when this pick is not a trip, so nothing may price it.
 *
 * Here rather than in `FlightPicker` because this module is what raises the warning, and
 * the rule about what a warning permits has to live beside the code that decides a warning
 * is due. Split across two files they drift, and the drift shows up as a price delta on an
 * itinerary the app already ruled out.
 */
export function selectionIsUnusable(selection: RecomputedSelection): boolean {
	return selection.warnings.some((warning) => !WARNING_LEAVES_A_JOURNEY[warning.code]);
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
	const transferToDestinationLocation =
		overrides.transferToDestinationLocation ?? itinerary.transferToDestinationLocation;
	// Left exactly as the source itinerary had them. See this file's header for why a
	// picker swap never reclassifies these on its own.
	const { originWaitingTime, connectionWaitingTime } = itinerary;
	// Issue #243: the bed and the two legs that reach it move as one, so a stay swap
	// replaces all three and a transport swap replaces only the leg it is about.
	// Issue #94: `stay` may be `undefined` — no bed priced for this connection — and the
	// two legs can still be real, since issue #161 gave them the city centre to route to.
	const { staySelection } = overrides;
	const stay = staySelection ? staySelection.stay : itinerary.stay;
	const transferToHotel = staySelection
		? staySelection.transferToHotel
		: (overrides.transferToHotel ?? itinerary.transferToHotel);
	const transferToConnectionAirport = staySelection
		? staySelection.transferToConnectionAirport
		: (overrides.transferToConnectionAirport ?? itinerary.transferToConnectionAirport);
	const transferAnchor = staySelection ? anchorForStaySelection(staySelection) : itinerary.transferAnchor;

	const warnings: ItineraryWarning[] = [];

	// RULE mirrors build.ts: layover is the raw flight-to-flight gap, never the airport
	// waiting-time buffer. Here it is checked, not filtered: an itinerary that fails it is
	// still returned, with the warning attached, per this module's whole point.
	//
	// Issue #247: the sign picks which fact is reported, because a negative gap is not a
	// short layover. Production said "Only -3230 minutes between the flights, below the
	// 30-minute minimum layover" for an outbound landing two days after the onward flight
	// left. `minutesBetween` was right — both times are LGW's own and it converts each
	// through its own offset before subtracting — but there was no layover there to be
	// short, and a negative duration is not a thing to print. A gap that is positive and
	// under the minimum still reads the way it always did; that is the case the sentence
	// was written for.
	const layover = minutesBetween(outboundFlight.arrival, onwardFlight.departure);
	const flightsOutOfOrder = layover < 0;
	if (flightsOutOfOrder) {
		warnings.push({
			code: 'flights-out-of-order',
			message: 'The onward flight leaves before this one lands, so there is no connection to make.'
		});
	} else if (layover < minLayoverTime) {
		warnings.push({
			code: 'layover-too-short',
			message:
				`Only ${layover} minute${layover === 1 ? '' : 's'} between the flights, ` +
				`below the ${minLayoverTime}-minute minimum layover.`
		});
	}

	const parts: ItineraryParts = {
		outboundFlight,
		onwardFlight,
		originWaitingTime,
		connectionWaitingTime,
		travellers: itinerary.travellers,
		stay,
		transferToOriginAirport,
		transferToHotel,
		transferToConnectionAirport,
		transferToDestinationLocation
	};
	// Issue #365's rule that a nightless stopover plans no ride to a bed lives in
	// `pairConnections`, not here. Every leg on this path is one the traveller picked, and
	// `recomputeItinerarySelection` answering a pick by deleting it is the thing the
	// `insufficient-connection-time` warning below exists to avoid: the app says what the
	// choice costs and leaves the choice standing.
	const derived = deriveItinerary(parts);

	// Not reported alongside `flights-out-of-order`, because there it is the consequence
	// rather than the cause and it names the wrong culprit. Two flights in the wrong order
	// leave negative free time whatever the transfers and the buffer are, and production
	// stacked both sentences on one row: the second blamed the transfers for a trip that
	// had no connection in it at all.
	if (derived.freeTime.duration < 0 && !flightsOutOfOrder) {
		warnings.push({
			code: 'insufficient-connection-time',
			message:
				'This connection no longer leaves enough time for the transfers and the ' +
				'waiting-time buffer around the flights: free time would be negative.'
		});
	}

	return {
		itinerary: { ...itinerary, ...parts, ...derived, transferAnchor },
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
