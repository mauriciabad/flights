/**
 * Issue #71's vocabulary: what "a year of cached prices" actually is in this app, and what
 * it deliberately is not.
 *
 * A `DayFare` is NOT a bookable quote. It is the cheapest one-adult fare some source once
 * reported for one route on one calendar day, together with which source said so and when.
 * Everything in this directory keeps those three facts welded together, because the whole
 * feature rests on being able to say "these three weeks, from prices cached on the 2nd, and
 * nothing at all for November" instead of drawing a smooth curve over coverage we do not
 * have. AGENTS.md: "never present an estimate as a fact", and "say what you do not know
 * rather than guessing".
 */

import type { IataAirportCode, IsoCalendarDate, IsoCurrencyCode } from '../domain';

/**
 * One route's cheapest fare on one departure date, as one source reported it.
 *
 * `minorUnits` is one adult's fare, never a party total. Sources whose price already covers
 * the whole party (`FlightOffer.priceScope === 'party-total'`, which is Skyscanner's shape,
 * measured, see `domain/flight-offer.ts`) are dropped at the collection boundary rather than
 * divided by the traveller count: that division is an average, not a fare, and this file's
 * whole job is to not invent numbers.
 *
 * `arrivalDate` is carried separately from `departureDate` and is the local calendar date at
 * the ARRIVAL airport. It is what makes a stopover length countable: an outbound that lands
 * at 00:20 has already used up a night, and collapsing the two dates into one is precisely
 * how "an overnight connection silently loses a night" (AGENTS.md).
 */
export interface DayFare {
	/** Local calendar date at the departure airport. */
	departureDate: IsoCalendarDate;
	/** Local calendar date at the arrival airport. The same day for most short-haul, the
	 * next one for a late departure. */
	arrivalDate: IsoCalendarDate;
	/** One adult's fare, integer minor units of `LegFares.currency`. */
	minorUnits: number;
	/** Which adapter reported it: `'ryanair'`, `'kiwi-public'`, and so on. */
	providerId: string;
	/** Epoch millis this number came off the provider's wire, never when it was read back
	 * out of the cache. The UI prints this age next to every figure it derives. */
	observedAt: number;
}

/** Why a source says a day carries no fare. Kept apart from "we never asked", because
 * "Ryanair does not fly this route" and "nobody has looked at November" are different
 * answers and only one of them is worth spending a request to change. */
export type BlankDayReason = 'sold-out' | 'no-service';

export interface BlankDay {
	date: IsoCalendarDate;
	reason: BlankDayReason;
	providerId: string;
	observedAt: number;
}

/** What one calendar month of one leg is actually known to be. `pricedDays + blankDays +
 * unknownDays` always equals the number of days in the month, so the UI can render coverage
 * as a fact rather than a vibe. */
export interface MonthCoverage {
	monthStart: IsoCalendarDate;
	pricedDays: number;
	blankDays: number;
	unknownDays: number;
	/** Every source that contributed anything to this month, newest observation first. */
	sources: { providerId: string; observedAt: number }[];
}

/** One leg of the trip (origin to stopover, or stopover to destination) and everything
 * known about its prices over the window the view covers. */
export interface LegFares {
	origin: IataAirportCode;
	destination: IataAirportCode;
	currency: IsoCurrencyCode;
	/** At most one entry per departure date, the cheapest across every source that has an
	 * opinion about that day. Sorted by `departureDate`. */
	fares: DayFare[];
	/** Days a source explicitly reported as unsellable. Never inferred from a missing fare. */
	blankDays: BlankDay[];
	/** One entry per calendar month in the requested window, in order, including months
	 * nothing is known about (`unknownDays` equal to the month's length). */
	months: MonthCoverage[];
}
