import type { IsoCurrencyCode, Money } from '../../domain';
import { moneyFromDecimalString, moneyFromMajorUnits } from '../../domain';

/**
 * `search-one-way`'s itinerary price carries both a number (`raw`, major units, e.g.
 * `60.99`) and a display string (`formatted`, e.g. `"61 €"`, already rounded — never the
 * canonical value per AGENTS.md's Money rule). `raw` is what this adapter is built against;
 * `formatted` is a last-resort fallback for a response that omits the number, the same
 * defensive shape skyscanner-money.ts's `parseOfferPrice` keeps for the same reason. Returns
 * `undefined`, never a fabricated 0, when neither parses, so the caller drops that one
 * itinerary instead of quoting a fictional price.
 *
 * The minor-unit exponent comes from `domain/money.ts` (issue #179). This file used to
 * carry its own six-code zero-decimal list, byte-identical to skyscanner-money.ts's, which
 * called the forint a zero-decimal currency while Agoda's own table called it a two-decimal
 * one. `price-calendar`'s bare float price (`34.0` for 34.00 EUR, a different shape from
 * this object) reads the same table, straight from `flights-sky-map-calendar.ts`.
 */
export function parseItineraryPrice(
	price: { raw?: unknown; formatted?: unknown } | undefined,
	currency: IsoCurrencyCode
): Money | undefined {
	if (price === undefined) return undefined;
	return fromRaw(price.raw, currency) ?? fromFormatted(price.formatted, currency);
}

function fromRaw(raw: unknown, currency: IsoCurrencyCode): Money | undefined {
	if (typeof raw === 'number') return moneyFromMajorUnits(raw, currency);
	// `raw` sometimes arrives as a numeric string. Read it digit-wise rather than through
	// `Number`, so a price that comes as text never touches a float.
	if (typeof raw === 'string') return moneyFromDecimalString(raw, currency);
	return undefined;
}

function fromFormatted(formatted: unknown, currency: IsoCurrencyCode): Money | undefined {
	if (typeof formatted !== 'string') return undefined;
	return moneyFromDecimalString(formatted.replace(/[^0-9.,]/g, '').replace(/,/g, ''), currency);
}
