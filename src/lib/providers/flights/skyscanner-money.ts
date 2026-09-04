import type { IsoCurrencyCode, Money } from '../../domain';

/**
 * Currencies whose smallest unit is the whole unit, not a hundredth of it. money.ts's
 * "integer minor units" only means something once you know how many decimal digits a
 * currency actually has. This is the short, stable exception list (ISO 4217 minor-unit
 * count 0); everything not listed here is assumed to have 2, which covers EUR/USD/GBP and
 * the overwhelming majority of currencies Sky Scrapper is likely to quote.
 */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<IsoCurrencyCode> = new Set([
	'JPY',
	'KRW',
	'VND',
	'CLP',
	'ISK',
	'HUF'
]);

function minorUnitsPerMajorUnit(currency: IsoCurrencyCode): number {
	return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
}

/**
 * Sky Scrapper's `price` object carries both a number (`raw`, in major units, e.g. `17.99`)
 * and a display string (`formatted`, e.g. `"18 €"`, already rounded, never the canonical
 * value AGENTS.md's Money rule calls for). `raw` is what this adapter is built against. The
 * `formatted`-only fallback exists because issue #5's brief specifically calls out watching
 * for a response that omits the number and gives only the string, which real aggregators do
 * for some fare types. Returns `undefined`, never a fabricated 0, when neither parses, so
 * the caller can drop that one offer instead of quoting a fictional price.
 */
export function parseOfferPrice(
	price: { raw?: unknown; formatted?: unknown } | undefined,
	currency: IsoCurrencyCode
): Money | undefined {
	const majorUnits = extractMajorUnits(price);
	if (majorUnits === undefined || !Number.isFinite(majorUnits) || majorUnits < 0) {
		return undefined;
	}
	const minorUnits = Math.round(majorUnits * minorUnitsPerMajorUnit(currency));
	return { minorUnits, currency };
}

function extractMajorUnits(price: { raw?: unknown; formatted?: unknown } | undefined): number | undefined {
	if (price === undefined) return undefined;
	if (typeof price.raw === 'number' && Number.isFinite(price.raw)) {
		return price.raw;
	}
	// Some responses give `raw` as a numeric string instead of a number.
	if (typeof price.raw === 'string' && price.raw.trim() !== '') {
		const parsed = Number(price.raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	// Last resort: strip everything but digits, dot and minus from the display string,
	// e.g. "18 €" -> "18", "$1,234.50" -> "1234.50". This is inherently lossy, since a
	// formatted price is usually already rounded, which is exactly why `raw` is always
	// tried first.
	if (typeof price.formatted === 'string') {
		const digitsOnly = price.formatted.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
		const parsed = Number(digitsOnly);
		if (digitsOnly !== '' && Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}
