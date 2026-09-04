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
 * A touchdown in the middle of ONE flight, where the aircraft lands to pick up or drop
 * passengers and fuel and everybody else stays on board. Issue #210, in the owner's words:
 *
 * > sometimes a flight may make a stop to gather more passangers but i dont have to get out
 * > of the plane. for me i dont count this as a layover
 *
 * The distinction is not cosmetic, it decides two things this app would otherwise get
 * dangerously wrong:
 *
 * 1. **This airport can never be the stopover city.** You cannot clear immigration, so
 *    proposing a few free days in Sal would send a traveller to a city they physically
 *    cannot enter. That is worse than never showing the route at all. The guarantee is
 *    structural rather than a rule anyone has to remember: `algorithm/build.ts` pairs an
 *    outbound leg's `arrivalAirport` with an onward leg's `departureAirport`, and a
 *    technical stop is on neither field of either offer, so it is not addressable as a
 *    connection point by construction.
 * 2. **Its ground time is inside `FlightOffer.duration`, never free time.** See the note on
 *    `duration` below.
 *
 * Both timestamps are wall-clock at this airport with its own offset, like every other time
 * in this app — a 23:50 touchdown that leaves at 00:40 crosses a date at the airport, and
 * normalising to UTC to subtract is how that hour goes missing.
 */
export interface TechnicalStop {
	airport: IataAirportCode;
	/** Wheels down. */
	arrival: LocalDateTime;
	/** Wheels up again, on the same aircraft under the same flight number. */
	departure: LocalDateTime;
	/** Minutes on the ground, from `arrival` to `departure`. Included in the offer's
	 * `duration`, so a consumer must not add it on top. */
	groundTime: Duration;
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
	/** Where the traveller boards. Never a technical stop — see `technicalStops`. */
	departureAirport: IataAirportCode;
	/** Where the traveller gets off for good. Never a technical stop. */
	arrivalAirport: IataAirportCode;
	departure: LocalDateTime;
	arrival: LocalDateTime;
	/** Computed once by whoever fetched this offer, from departure and arrival, so no
	 * consumer has to redo timezone-aware subtraction across a possible date change.
	 * Brief line 57: "In-flight time".
	 *
	 * Gate to gate, so on an offer with `technicalStops` this INCLUDES the time parked at
	 * each of them. Door-to-door total is the number this product is judged on
	 * (docs/ACCEPTANCE.md), and `algorithm/build.ts` reaches it by summing the two legs'
	 * `duration` alongside the transfers; leaving a touchdown hour out here would silently
	 * shorten the whole trip by an hour. The cost of that choice is that the "In flight"
	 * metric slightly overstates airborne time on such an offer, which is the smaller and
	 * far more visible of the two errors — the stop is named on the card right beside it. */
	duration: Duration;
	/** Touchdowns between `departureAirport` and `arrivalAirport` on this one flight, in
	 * order, where nobody leaves the aircraft. Absent or empty means a true nonstop, which
	 * is what every provider except Kiwi's public endpoint can currently report. A
	 * non-empty list is a promise the card must keep: "1 stop, no plane change" is the
	 * honest claim, and rendering such an offer as a nonstop is not (issue #210). */
	technicalStops?: TechnicalStop[];
	price: Money;
	/** See `FlightFarePriceScope`'s own doc comment — issue #109. */
	priceScope: FlightFarePriceScope;
	/** e.g. "Basic", "Plus" — not every provider exposes a fare brand. */
	fareBrand?: string;
	baggage: BaggageAllowance;
	/** Link to book or view this exact offer on the provider's site. */
	deepLink: string;
}
