/**
 * Money maths for the stay picker. Deliberately mirrors two computations that already
 * exist elsewhere in this codebase, rather than inventing a third interpretation:
 *
 * - `src/lib/algorithm/build.ts` totals an itinerary's stay cost as
 *   `stay.pricePerNight.minorUnits * nightsInConnection` - no traveller multiplier.
 * - The itinerary timeline (issue #24, PR #63) computes its own `staySubtotal` the same
 *   way, for the same `Stay`.
 *
 * A picker that priced a night differently (e.g. per traveller) would make its own
 * total disagree with the itinerary it is meant to feed, at the one place both would
 * need to add up. Following the existing convention exactly is what makes issue #27's
 * acceptance test - "switching dorm to private changes the itinerary total by exactly
 * the difference times the number of nights" - true by construction rather than by
 * coincidence: both totals are linear in `pricePerNight`, so their difference is too.
 */

import type { Money } from '$lib/domain';

/** The stay's contribution to the itinerary total: this room kind's nightly price times
 * the nights actually spent in the connection city. Nights <= 0 (a day stopover with no
 * overnight, domain/itinerary.ts `nightsInConnection`) prices at zero rather than going
 * negative on a bad input. */
export function stayTotalForNights(pricePerNight: Money, nights: number): Money {
	return { minorUnits: pricePerNight.minorUnits * Math.max(0, nights), currency: pricePerNight.currency };
}

/** `next` minus `previous`, both already totalled for the same number of nights - what
 * changes on the itinerary total when the selected stay changes. Throws on a currency
 * mismatch rather than guessing an exchange rate, same guard as build.ts's own
 * `sumMoney`: converting between currencies is out of scope here too. */
export function moneyDifference(previous: Money, next: Money): Money {
	if (previous.currency !== next.currency) {
		throw new Error(`Cannot compare a mix of currencies (${previous.currency} and ${next.currency}).`);
	}
	return { minorUnits: next.minorUnits - previous.minorUnits, currency: previous.currency };
}

/** How much the itinerary total changes by switching from `previous` to `next`, already
 * multiplied out for `nights` - the exact quantity issue #27's acceptance test checks. */
export function stayTotalDelta(previous: Money, next: Money, nights: number): Money {
	return moneyDifference(stayTotalForNights(previous, nights), stayTotalForNights(next, nights));
}

/** Display only, never the canonical value (AGENTS.md "Money"). Matches
 * `algorithm/crosscheck.ts`'s own `formatMoney`: `Intl` already knows each currency's
 * minor-unit digit count (0 for JPY, 2 for most, 3 for KWD), which is exactly what's
 * needed to turn integer minor units back into a display amount without this module
 * hardcoding a currency-to-exponent table of its own. */
export function formatMoney(money: Money): string {
	const formatter = new Intl.NumberFormat('en-GB', { style: 'currency', currency: money.currency });
	const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
	return formatter.format(money.minorUnits / 10 ** digits);
}
