import type { IsoCurrencyCode, Money } from '../../domain';
import { moneyFromDecimalString, moneyFromFormattedString, moneyFromMajorUnits } from '../../domain';

/**
 * Sky Scrapper's `price` object carries both a number (`raw`, in major units, e.g. `17.99`)
 * and a display string (`formatted`, e.g. `"18 €"`, already rounded, never the canonical
 * value AGENTS.md's Money rule calls for). `raw` is what this adapter is built against. The
 * `formatted`-only fallback exists because issue #5's brief specifically calls out watching
 * for a response that omits the number and gives only the string, which real aggregators do
 * for some fare types. Returns `undefined`, never a fabricated 0, when neither parses, so
 * the caller can drop that one offer instead of quoting a fictional price.
 *
 * How many minor units make a major one comes from `domain/money.ts` (issue #179). This
 * file used to keep its own six-code list of zero-decimal currencies, byte-identical to the
 * one in `flights-sky-money.ts` and disagreeing with Agoda's table about the forint.
 */
export function parseOfferPrice(
	price: { raw?: unknown; formatted?: unknown } | undefined,
	currency: IsoCurrencyCode
): Money | undefined {
	if (price === undefined) return undefined;
	return fromRaw(price.raw, currency) ?? moneyFromFormattedString(price.formatted, currency);
}

function fromRaw(raw: unknown, currency: IsoCurrencyCode): Money | undefined {
	if (typeof raw === 'number') return moneyFromMajorUnits(raw, currency);
	// Some responses give `raw` as a numeric string instead of a number. Read that
	// digit-wise, so a price that arrives as text never goes through a float at all.
	if (typeof raw === 'string') return moneyFromDecimalString(raw, currency);
	return undefined;
}

// The display-string fallback is `moneyFromFormattedString` in domain/money.ts. It used to
// be six lines here and six identical lines in flights-sky-money.ts, and both read
// "60,99 €" as 6099 euros because both deleted the comma as a thousands separator (issue
// #192). Two copies of one rule is how #179 happened as well, so there is now one.
