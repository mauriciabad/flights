import type { IsoCurrencyCode } from './codes';

/**
 * A price or cost: an integer count of the currency's smallest unit (cents for EUR/USD,
 * no minor unit at all for JPY) plus the currency it is in.
 *
 * AGENTS.md "Money": "Integer minor units and a currency code. Never a float, never a
 * formatted string as the canonical value. Convert at the edges, compare in minor units."
 * Issue #1: "Money — integer minor units plus currency. Never a float."
 * Brief line 54: "Price of each part and in total."
 */
export interface Money {
	minorUnits: number;
	currency: IsoCurrencyCode;
}
