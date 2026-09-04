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

/**
 * The currency this app asks every provider to quote in, and the one every price on screen
 * is therefore in. One value, imported everywhere, rather than a literal repeated at each
 * call site.
 *
 * Issue #158: `SearchDependencies.currency` existed, was threaded correctly through the
 * whole pipeline into the flight leg queries and the stay query, and nothing ever set it.
 * Agoda was therefore called with no `currency_id`, answered in USD (its documented default
 * when the parameter is omitted — `agoda-mapper.ts`), and `sumMoney` refused to total a USD
 * bed against EUR flights, so the one candidate whose stay actually resolved was the one
 * candidate that got dropped. Pricing a bed deleted the trip.
 *
 * EUR because that is what the app's users and every captured fixture in this repo use, and
 * because `SearchQuery` has no currency field: the brief never asks the traveller to pick
 * one. When it does, this constant becomes that field's default rather than its only value,
 * and `SearchDependencies.currency` — which is deliberately required, so a construction site
 * cannot silently omit it again — is already the seam to pass it through.
 */
export const DEFAULT_SEARCH_CURRENCY: IsoCurrencyCode = 'EUR';
