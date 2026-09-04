/**
 * The currencies the settings picker offers.
 *
 * ## Why a short list, and why exactly this one
 *
 * About 180 ISO 4217 codes are in active use. Offering all of them would mean offering
 * the Cape Verdean escudo for a Boa Vista trip, which reads as a promise: pick it and the
 * providers will quote escudos. None of them would, and issue #158 is what that costs. A
 * stay quoted in a currency the flights are not in gets dropped by `resources.ts` rather
 * than converted, so a currency no stay provider honours means a trip with no bed priced.
 *
 * So the list is derived, not taste. It is every currency that satisfies both:
 *
 * 1. **A stay provider can be asked for it.** Agoda takes a numeric `currency_id`, and
 *    `AGODA_CURRENCY_INFO` (`providers/stays/agoda-mapper.ts`, captured live 2026-09-04)
 *    is the mapping we have. A code missing from that table makes Agoda omit the
 *    parameter and answer USD, which is precisely the bug. USD itself is in because it is
 *    Agoda's own implicit default. Booking takes an ISO `currency_code` and is not the
 *    binding constraint; the flight adapters all pass the code straight through.
 * 2. **Every adapter agrees on its minor-unit exponent.** JPY and HUF are excluded for
 *    this reason alone. `ZERO_DECIMAL_CURRENCIES` (`flights/skyscanner-money.ts` and
 *    `flights/flights-sky-money.ts`) treats HUF as having no minor unit while Agoda's own
 *    table gives it two, and `booking-mapper.ts` multiplies every price by 100 regardless,
 *    which is wrong for JPY. Offering either would put a flight and a bed a factor of 100
 *    apart inside one total. That disagreement is issue #179; until it is settled, this
 *    picker hands nobody a currency we know we scale inconsistently.
 *
 * Twelve entries is also what makes the picker a grid of tiles a thumb can hit rather
 * than a dropdown nobody scrolls to the bottom of.
 *
 * A code outside this list still works. `keys/storage.ts` keeps any well-formed code it
 * finds and an imported key file can carry one, so `CurrencyPicker` renders such a code as
 * its own tile instead of showing EUR selected while searches run in something else.
 *
 * `DEFAULT_SEARCH_CURRENCY` is not redefined here: it belongs to `domain/money.ts` (issue
 * #158) and is what a search falls back to when nobody has chosen. This file only decides
 * what the picker offers.
 *
 * `symbol` is display-only and never used to format an amount. `formatMoney`
 * (`results/format.ts`) asks `Intl` for that, which also knows each currency's exponent,
 * so a zero-decimal currency would still print correctly without a table here.
 */

import type { IsoCurrencyCode } from '../domain';

export interface SearchCurrency {
	code: IsoCurrencyCode;
	/** English name, as a traveller would recognise it. */
	name: string;
	/** Display glyph for the picker tile. Never used to format an amount. */
	symbol: string;
}

export const SUPPORTED_CURRENCIES: readonly SearchCurrency[] = [
	{ code: 'EUR', name: 'Euro', symbol: '€' },
	{ code: 'GBP', name: 'British pound', symbol: '£' },
	{ code: 'USD', name: 'US dollar', symbol: '$' },
	{ code: 'CHF', name: 'Swiss franc', symbol: 'Fr' },
	{ code: 'DKK', name: 'Danish krone', symbol: 'kr' },
	{ code: 'SEK', name: 'Swedish krona', symbol: 'kr' },
	{ code: 'NOK', name: 'Norwegian krone', symbol: 'kr' },
	{ code: 'PLN', name: 'Polish zloty', symbol: 'zł' },
	{ code: 'CZK', name: 'Czech koruna', symbol: 'Kč' },
	{ code: 'AUD', name: 'Australian dollar', symbol: '$' },
	{ code: 'NZD', name: 'New Zealand dollar', symbol: '$' },
	{ code: 'SGD', name: 'Singapore dollar', symbol: '$' }
];

export function findCurrency(code: IsoCurrencyCode): SearchCurrency | undefined {
	return SUPPORTED_CURRENCIES.find((currency) => currency.code === code);
}

/**
 * What the picker renders: the catalogue above, plus `saved` as an extra tile when it is a
 * code the catalogue does not carry. A key file from a newer build, or one somebody
 * hand-edited, can name a currency this release does not offer, and a screen showing EUR
 * selected while every search asks for something else is the failure this repo keeps
 * paying for. Better an unfamiliar tile than a confident wrong one.
 */
export function currencyOptions(saved: IsoCurrencyCode | undefined): readonly SearchCurrency[] {
	if (saved === undefined || findCurrency(saved)) return SUPPORTED_CURRENCIES;
	return [...SUPPORTED_CURRENCIES, { code: saved, name: 'From an imported key file', symbol: saved }];
}
