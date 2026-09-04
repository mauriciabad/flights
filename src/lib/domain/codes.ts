/**
 * Bare identifier types shared across the domain, kept in one file so, for example,
 * money.ts doesn't have to import from flight-offer.ts just to name a currency code.
 */

/** ISO 4217 currency code, e.g. "EUR", "USD". See money.ts and AGENTS.md "Money". */
export type IsoCurrencyCode = string;

/** ISO 3166-1 alpha-2 country code, e.g. "AT". Brief line 35: forbidden connection
 * countries. */
export type IsoCountryCode = string;

/** 3-letter IATA airport code, e.g. "VIE". Brief lines 30-31 and 38 (origin/destination
 * and connection airports). */
export type IataAirportCode = string;

/** 2-letter IATA airline code, e.g. "FR" for Ryanair. Brief line 36: airlines to avoid. */
export type IataAirlineCode = string;
