import type { IataAirlineCode, IataAirportCode } from './codes';
import type { LocalDateTime } from './datetime';
import type { Duration } from './duration';
import type { Money } from './money';

export interface Carrier {
	iataCode: IataAirlineCode;
	name: string;
}

/**
 * Brief line 62: "airlines and flight details". Counts only, since "included" baggage
 * differs by fare and providers rarely give more structure than a number per bag type.
 */
export interface BaggageAllowance {
	cabinBagsIncluded: number;
	checkedBagsIncluded: number;
}

/**
 * Issue #1: "FlightOffer — carrier, number, aircraft, departure/arrival as instants with
 * the local timezone kept separately, price, fare brand, baggage, deep link."
 * Brief line 62.
 */
export interface FlightOffer {
	carrier: Carrier;
	/** e.g. "FR1234". */
	flightNumber: string;
	/** Not every provider gives equipment type for every leg. */
	aircraft?: string;
	departureAirport: IataAirportCode;
	arrivalAirport: IataAirportCode;
	departure: LocalDateTime;
	arrival: LocalDateTime;
	/** Computed once by whoever fetched this offer, from departure and arrival, so no
	 * consumer has to redo timezone-aware subtraction across a possible date change.
	 * Brief line 57: "In-flight time". */
	duration: Duration;
	price: Money;
	/** e.g. "Basic", "Plus" — not every provider exposes a fare brand. */
	fareBrand?: string;
	baggage: BaggageAllowance;
	/** Link to book or view this exact offer on the provider's site. */
	deepLink: string;
}
