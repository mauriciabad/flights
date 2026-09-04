/**
 * Shape-checking for the traveller's chosen search currency, at the two boundaries where
 * a value arrives from outside this app: `localStorage` (`storage.ts`) and an imported
 * key file (`codec.ts`). Both can hold anything, and whatever they hold ends up in a
 * query string bound for a provider.
 *
 * This lives next to the keys rather than next to the currency catalogue
 * (`settings/currencies.ts`) because it is a persistence concern: the catalogue decides
 * what the picker offers, this decides what is safe to read back. The two are separate on
 * purpose. A code the catalogue no longer lists still round-trips through here, so
 * dropping a currency from the picker in a later release never silently rewrites a
 * setting somebody already made.
 */

import type { IsoCurrencyCode } from '../domain';

/** ISO 4217 is three uppercase letters and nothing else. This checks the shape, never
 * whether the code names a currency anyone trades: a made-up `ZZZ` passes, and is then
 * simply a currency no provider answers in, which is the same outcome as a real code a
 * provider happens not to support. What it does rule out is a value that was never a
 * currency code at all reaching a provider's query string. */
export function isWellFormedCurrencyCode(raw: string): boolean {
	return /^[A-Z]{3}$/.test(raw);
}

/** Trims and uppercases a candidate code, or `undefined` when what is left is not a
 * well-formed ISO 4217 code. `undefined` means "nothing saved", which every caller reads
 * as "use the default". A corrupt value must never be more sticky than an absent one. */
export function normalizeCurrencyCode(raw: unknown): IsoCurrencyCode | undefined {
	if (typeof raw !== 'string') return undefined;
	const code = raw.trim().toUpperCase();
	return isWellFormedCurrencyCode(code) ? code : undefined;
}
