import type { IsoCurrencyCode } from './codes';

/**
 * A price or cost: an integer count of the currency's smallest unit (cents for EUR/USD,
 * no minor unit at all for JPY) plus the currency it is in.
 *
 * AGENTS.md "Money": "Integer minor units and a currency code. Never a float, never a
 * formatted string as the canonical value. Convert at the edges, compare in minor units."
 * Issue #1: "Money — integer minor units plus currency. Never a float."
 * Brief line 54: "Price of each part and in total."
 *
 * `minorUnits` only means something once you know how many of them make a major unit, so
 * build one with `moneyFromMajorUnits` or `moneyFromDecimalString` below rather than
 * multiplying by 100 at the call site. That is issue #179: three adapters each answered
 * "how many decimal digits does this currency have" for themselves and two of them got
 * HUF wrong by a factor of 100.
 */
export interface Money {
	minorUnits: number;
	currency: IsoCurrencyCode;
}

/**
 * How many decimal digits separate a currency's major unit from its minor one — ISO 4217
 * calls this the currency's exponent. 2 for the euro's cents, 0 for the yen, which has no
 * minor unit at all, 3 for the Kuwaiti dinar's fils, 4 for a couple of accounting units.
 *
 * A union rather than `number` so a caller cannot invent a fifth answer, and so
 * `10 ** exponent` is always one of four known divisors.
 */
export type CurrencyExponent = 0 | 2 | 3 | 4;

/** What a currency nobody has an entry for is worth assuming: cents, like most of the
 * world. Named rather than inlined so the fallback is greppable from a wrong price. */
export const DEFAULT_CURRENCY_EXPONENT: CurrencyExponent = 2;

/**
 * Every currency whose exponent is not 2, grouped by what it is instead. Anything absent
 * has cents.
 *
 * ## Where these numbers come from, and why they are not read off `Intl`
 *
 * ISO 4217's own published exponents, hardcoded. `Intl.NumberFormat` will answer the same
 * question, and #179 suggested asking it, but its answer is CLDR's rather than ISO's and it
 * changes between ICU versions. Measured on this branch's own CI run
 * (github.com/mauriciabad/flights/actions/runs/33904155492), Node 22 and Node 25 disagree
 * about five codes:
 *
 * | code | Node 22, on CI | Node 25, where this was written | ISO 4217 |
 * | --- | --- | --- | --- |
 * | HUF | 0 | 2 | 2 |
 * | COP | 0 | 2 | 2 |
 * | IDR | 0 | 2 | 2 |
 * | PKR | 0 | 2 | 2 |
 * | RSD | 2 | 0 | 2 |
 *
 * The forint is the first row. Deriving the exponent from `Intl` would have made a 45000.00
 * HUF fare parse as 45000 minor units on one runtime and 4500000 on another — the exact bug
 * #179 exists to fix, reintroduced by the fix. A browser's currency data is older or newer
 * than ours and we do not control it, so the canonical value cannot depend on it.
 *
 * Display is kept in step the other way round: `format.ts` hands `Intl` the digit count from
 * this table instead of letting it choose, so an old ICU cannot print a forint price at a
 * different scale from the one it was stored at. `format.test.ts` asserts that output
 * character for character, and it passes on both runtimes above.
 *
 * The cost of following ISO rather than CLDR is cosmetic and confined to currencies no
 * provider here can be asked for: CLDR treats the Lebanese pound and the Albanian lek as
 * having no minor unit, because nobody quotes piastres or qindarka, while ISO gives both
 * two. Prices in those still add up and still round-trip; they just print ".00".
 */
const ZERO_DECIMAL_CURRENCIES = [
	'BIF',
	'CLP',
	'DJF',
	'GNF',
	'ISK',
	'JPY',
	'KMF',
	'KRW',
	'PYG',
	'RWF',
	'UGX',
	'UYI',
	'VND',
	'VUV',
	'XAF',
	'XOF',
	'XPF'
] as const;

/** Gulf and North African dinars, whose minor unit is a thousandth: 1.500 KWD is one and a
 * half dinars, not fifteen hundred of anything. */
const THREE_DECIMAL_CURRENCIES = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'] as const;

/** Inflation-indexed accounting units rather than money anyone carries — the Chilean
 * unidad de fomento and the Uruguayan unidad previsional. Listed for completeness against
 * ISO 4217, not because a fare will ever be quoted in one. */
const FOUR_DECIMAL_CURRENCIES = ['CLF', 'UYW'] as const;

const CURRENCY_EXPONENTS: ReadonlyMap<string, CurrencyExponent> = new Map<string, CurrencyExponent>([
	...ZERO_DECIMAL_CURRENCIES.map((code) => [code, 0] as const),
	...THREE_DECIMAL_CURRENCIES.map((code) => [code, 3] as const),
	...FOUR_DECIMAL_CURRENCIES.map((code) => [code, 4] as const)
]);

/** Codes arrive from provider responses and from imported key files, so they arrive in
 * whatever case and padding the sender felt like. Everything below compares and stores the
 * trimmed upper-case form, so `sumMoney` never refuses to add "eur" to "EUR".
 *
 * Three letters, because that is what a currency code is and what `Intl` will accept:
 * `format.ts` throws a `RangeError` on anything else, and a price that takes the results
 * page down when it renders is worse than a price that was dropped when it was read. */
function normaliseCurrencyCode(currency: unknown): string | undefined {
	if (typeof currency !== 'string') return undefined;
	const code = currency.trim().toUpperCase();
	return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/**
 * How many decimal digits this currency's minor unit has. The one answer in the app:
 * every adapter that turns a provider's price into `Money`, and every place that turns
 * `Money` back into an amount, reads it from here (issue #179).
 */
export function currencyExponent(currency: IsoCurrencyCode): CurrencyExponent {
	const code = normaliseCurrencyCode(currency);
	if (code === undefined) return DEFAULT_CURRENCY_EXPONENT;
	return CURRENCY_EXPONENTS.get(code) ?? DEFAULT_CURRENCY_EXPONENT;
}

/** `10 ** currencyExponent(currency)`: 100 for EUR, 1 for JPY, 1000 for KWD. */
export function minorUnitsPerMajorUnit(currency: IsoCurrencyCode): number {
	return 10 ** currencyExponent(currency);
}

/**
 * A price a provider sent as a number in major units (`17.99`) as `Money`.
 *
 * Takes `unknown`, and returns `undefined` rather than a fabricated price, because every
 * caller is reading an unverified response body: `null * 100` is `0` in JavaScript, not an
 * error, so an unchecked missing price becomes a real, wrong, free one. A negative price is
 * rejected on the same grounds — no provider quotes one, so it means the field being read
 * is not the field that was meant.
 *
 * `Math.round` after the multiplication, never a cast: `19.99 * 100` is
 * `1998.9999999999998` in binary floating point, and truncating that undercharges by a
 * cent. The error is always far under half a minor unit, so rounding is exact.
 */
export function moneyFromMajorUnits(majorUnits: unknown, currency: unknown): Money | undefined {
	const code = normaliseCurrencyCode(currency);
	if (code === undefined) return undefined;
	if (typeof majorUnits !== 'number' || !Number.isFinite(majorUnits) || majorUnits < 0) return undefined;
	const minorUnits = Math.round(majorUnits * minorUnitsPerMajorUnit(code));
	if (!Number.isSafeInteger(minorUnits)) return undefined;
	return { minorUnits, currency: code };
}

/**
 * A price a provider sent as a decimal string ("173", "19.99", Ryanair's pre-split
 * "45000" + "00") as `Money`, read digit by digit so no float is involved at all.
 *
 * Preferred over `moneyFromMajorUnits` whenever the wire format is a string. `Number()`
 * then multiply is exact for every amount a provider will realistically send. This is exact
 * for all of them, and it costs one regex.
 *
 * Digits past the currency's exponent are rounded, not dropped, so a provider that sends
 * cents for a currency that has none ("12000.60" JPY) reports the nearest yen rather than
 * quietly losing the fraction in a direction that always favours the same side.
 */
export function moneyFromDecimalString(amount: unknown, currency: unknown): Money | undefined {
	const code = normaliseCurrencyCode(currency);
	if (code === undefined || typeof amount !== 'string') return undefined;
	// Deliberately no sign, no thousands separator, no exponent notation: those are shapes
	// this app has never seen from a provider, and guessing at one is how a localised
	// "1.234,50" becomes 1.23.
	const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
	if (match === null) return undefined;

	const exponent = currencyExponent(code);
	const [, whole, fraction = ''] = match;
	const padded = fraction.padEnd(exponent, '0');
	const kept = padded.slice(0, exponent);
	const firstDroppedDigit = Number.parseInt(padded.slice(exponent, exponent + 1) || '0', 10);

	const minorUnits =
		Number.parseInt(whole, 10) * 10 ** exponent +
		(kept === '' ? 0 : Number.parseInt(kept, 10)) +
		(firstDroppedDigit >= 5 ? 1 : 0);
	if (!Number.isSafeInteger(minorUnits)) return undefined;
	return { minorUnits, currency: code };
}

/**
 * The other edge: integer minor units back to the amount a person reads, 4500000 HUF minor
 * units to 45000. Display only — `format.ts` is what a screen should call. Never store the
 * result, never compare two of them.
 */
export function majorUnitsOf(money: Money): number {
	return money.minorUnits / minorUnitsPerMajorUnit(money.currency);
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
 * one. The settings screen does (issue #180), so this is now that picker's default rather
 * than the only value; `SearchDependencies.currency` — deliberately required, so a
 * construction site cannot silently omit it again — is the seam it passes through.
 */
export const DEFAULT_SEARCH_CURRENCY: IsoCurrencyCode = 'EUR';
