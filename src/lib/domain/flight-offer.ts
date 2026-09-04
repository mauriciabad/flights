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
 * Issue #109: whether `FlightOffer.price` already covers every traveller the search asked
 * for, or is still a single adult's fare that the itinerary builder must multiply by the
 * party size. Required on every `FlightOffer` — never a default, never inferred from the
 * provider id at the call site — so a new adapter cannot compile without answering the
 * question, and a wrong answer here is the specific "worse than the bug it fixes" failure
 * issue #109 found live: Skyscanner's `adults` parameter already returns the whole party's
 * total (measured 2026-09-04, BCN→DUB: 1 adult €588.97, 3 adults €1766.38 — not €1766.91),
 * so multiplying it again would roughly triple a group's quoted fare. Ryanair's
 * fare-finder has no `adults` parameter at all and always returns one adult's fare, so
 * `travellers` must be multiplied in for a real party total. Set this per offer, never
 * per provider as a constant assumption, since the same itinerary can pair legs from two
 * different providers with different answers.
 *
 * - `'per-person'`: `price` is one adult's fare. The itinerary builder multiplies it by
 *   `Itinerary.travellers`.
 * - `'party-total'`: `price` already covers the whole party. The itinerary builder uses
 *   it unscaled.
 *
 * An adapter that cannot verify which its own provider does (`providers/flights/kiwi.ts`'s
 * backend was returning 402 at the time this field was added, so its live behaviour could
 * not be measured) must not guess `'party-total'` on the hope it matches Skyscanner: an
 * unconfirmed `'party-total'` that turns out to be per-person silently undercounts a group
 * total again, the original #106 bug, and an unconfirmed `'per-person'` that turns out to
 * already be scaled overcounts, the worse #109 bug. The only response of a required field
 * that carries no truth value nobody checked is for the adapter itself to stop sending a
 * traveller count it can't interpret the answer to — request pricing for exactly one adult
 * regardless of the real party size (as `flights-sky.ts` already does structurally: its
 * `SearchOneWayParams` has no adults field to send in the first place) and honestly declare
 * `'per-person'`, true by construction rather than by assumption.
 */
export type FlightFarePriceScope = 'per-person' | 'party-total';

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
	/** See `FlightFarePriceScope`'s own doc comment — issue #109. */
	priceScope: FlightFarePriceScope;
	/** e.g. "Basic", "Plus" — not every provider exposes a fare brand. */
	fareBrand?: string;
	baggage: BaggageAllowance;
	/** Link to book or view this exact offer on the provider's site. */
	deepLink: string;
}
