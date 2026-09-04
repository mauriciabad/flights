import type { AirportSizeClass } from './airport';
import type { Duration } from './duration';

/**
 * Brief line 39: "would be nice to allow multiple values based on airport size and flight
 * duration, like sort[short] flight or small airport 2h, long flight or large airport 3h."
 */
export type FlightLengthClass = 'short' | 'long';

/**
 * One tier of the waiting-time table. Airport waiting time is explicitly NOT layover
 * time: it is the buffer taken before a flight departs — whether that flight is the first
 * leg or the onward connection — not the gap between an arrival and the next departure.
 *
 * Brief line 58: "Airport waiting time (2h before flight + layovers. this is not time
 * between flights)"; interpretation note lines 104-105: "'Airport waiting time' is
 * explicitly *not* layover time. It is the buffer before a flight, defaulting to 2h."
 *
 * Leave a matcher field out to mean "matches regardless of that dimension". How several
 * matching rules combine (e.g. a short flight at a large airport) is the itinerary
 * builder's concern (issue #13), not this type's.
 */
export interface WaitingTimeRule {
	airportSize?: AirportSizeClass;
	flightLength?: FlightLengthClass;
	waitingTime: Duration;
}

/**
 * 2h everywhere. The owner, after seeing 3h on his own search: "the default waiting
 * airport time is too much 3h. i want 2h always by default."
 *
 * Brief line 39 offered a 3h tier for a long flight at a large airport as an example,
 * and it shipped as a rule. He has now overruled it, so the tier is gone rather than
 * merely retuned: the tiering machinery stays (a traveller can still add rules of their
 * own in the search form), but the app ships one flat number.
 */
export const DEFAULT_WAITING_TIME_RULES: WaitingTimeRule[] = [{ waitingTime: 120 as Duration }];

/** Flat fallback for callers that want one number rather than the tiered rules above
 * (search form issue #16: "a single number is the fallback, not the whole feature"). */
export const DEFAULT_AIRPORT_WAITING_TIME_MINUTES = 120 as Duration;

/**
 * Brief line 39, second half: "Also for landing to transport time, usually 15min or
 * 30min depending on the airport size." Same shape as WaitingTimeRule minus the
 * flight-length axis, since the brief never ties this one to flight duration.
 */
export interface LandingToTransportRule {
	airportSize?: AirportSizeClass;
	time: Duration;
}

export const DEFAULT_LANDING_TO_TRANSPORT_RULES: LandingToTransportRule[] = [
	{ time: 15 as Duration },
	{ airportSize: 'large', time: 30 as Duration }
];

/** Flat fallback, same reasoning as DEFAULT_AIRPORT_WAITING_TIME_MINUTES above. */
export const DEFAULT_LANDING_TO_TRANSPORT_TIME_MINUTES = 15 as Duration;
