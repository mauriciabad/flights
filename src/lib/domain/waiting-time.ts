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

/** Brief line 39 default: 2h flat, with the 3h long-flight/large-airport tier it
 * explicitly calls out as an example. */
export const DEFAULT_WAITING_TIME_RULES: WaitingTimeRule[] = [
	{ waitingTime: 120 as Duration },
	{ airportSize: 'large', flightLength: 'long', waitingTime: 180 as Duration }
];

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
