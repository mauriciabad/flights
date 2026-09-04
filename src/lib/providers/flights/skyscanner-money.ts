import type { IsoCurrencyCode, Money } from '../../domain';
import { moneyFromDecimalString, moneyFromMajorUnits } from '../../domain';

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
	return fromRaw(price.raw, currency) ?? fromFormatted(price.formatted, currency);
}

function fromRaw(raw: unknown, currency: IsoCurrencyCode): Money | undefined {
	if (typeof raw === 'number') return moneyFromMajorUnits(raw, currency);
	// Some responses give `raw` as a numeric string instead of a number. Read that
	// digit-wise, so a price that arrives as text never goes through a float at all.
	if (typeof raw === 'string') return moneyFromDecimalString(raw, currency);
	return undefined;
}

/** Last resort: strip everything but digits and the decimal point from the display string,
 * e.g. "18 €" -> "18", "$1,234.50" -> "1234.50". Inherently lossy, since a formatted price
 * is usually already rounded, which is why `raw` is always tried first. */
function fromFormatted(formatted: unknown, currency: IsoCurrencyCode): Money | undefined {
	if (typeof formatted !== 'string') return undefined;
	return moneyFromDecimalString(formatted.replace(/[^0-9.,]/g, '').replace(/,/g, ''), currency);
}
