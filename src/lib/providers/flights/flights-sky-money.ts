import type { IsoCurrencyCode, Money } from '../../domain';

/**
 * Currencies whose smallest unit is the whole unit, not a hundredth of it — same short,
 * stable exception list as skyscanner-money.ts (ISO 4217 minor-unit count 0). Everything not
 * listed here is assumed to have 2, which covers EUR/USD/GBP and the currencies this API is
 * likely to quote.
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
 * `price-calendar`'s `price` field is a bare float in major units (`34.0` for 34.00 EUR),
 * not an object — a different shape from `search-one-way`'s `price.raw` (see
 * `parseItineraryPrice` below). This is the one place that float becomes `Money`.
 *
 * This issue's brief names the exact trap: `19.99 * 100` is `1998.9999999999998` in
 * JavaScript, not `1999`, because 19.99 has no exact binary floating-point representation.
 * `Math.round` after the multiplication — not a naive `* 100` cast to an integer, which
 * would truncate that `.9999999999998` down to `1998` and silently undercharge by a cent —
 * is what fixes it, since the error is always well under half a minor unit.
 */
export function moneyFromMajorUnits(majorUnits: unknown, currency: IsoCurrencyCode): Money | undefined {
	if (typeof majorUnits !== 'number' || !Number.isFinite(majorUnits) || majorUnits < 0) {
		return undefined;
	}
	return { minorUnits: Math.round(majorUnits * minorUnitsPerMajorUnit(currency)), currency };
}

/**
 * `search-one-way`'s itinerary price carries both a number (`raw`, major units, e.g.
 * `60.99`) and a display string (`formatted`, e.g. `"61 €"`, already rounded — never the
 * canonical value per AGENTS.md's Money rule). `raw` is what this adapter is built against;
 * `formatted` is a last-resort fallback for a response that omits the number, the same
 * defensive shape skyscanner-money.ts's `parseOfferPrice` keeps for the same reason. Returns
 * `undefined`, never a fabricated 0, when neither parses, so the caller drops that one
 * itinerary instead of quoting a fictional price.
 */
export function parseItineraryPrice(
	price: { raw?: unknown; formatted?: unknown } | undefined,
	currency: IsoCurrencyCode
): Money | undefined {
	const majorUnits = extractMajorUnits(price);
	if (majorUnits === undefined) return undefined;
	return moneyFromMajorUnits(majorUnits, currency);
}

function extractMajorUnits(price: { raw?: unknown; formatted?: unknown } | undefined): number | undefined {
	if (price === undefined) return undefined;
	if (typeof price.raw === 'number' && Number.isFinite(price.raw)) {
		return price.raw;
	}
	if (typeof price.raw === 'string' && price.raw.trim() !== '') {
		const parsed = Number(price.raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof price.formatted === 'string') {
		const digitsOnly = price.formatted.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
		const parsed = Number(digitsOnly);
		if (digitsOnly !== '' && Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}
