import { describe, expect, it } from 'vitest';
import { currencyExponent } from '../domain';
import { AGODA_CURRENCY_IDS } from '../providers/stays/agoda-mapper';
import { currencyOptions, findCurrency, SUPPORTED_CURRENCIES } from './currencies';

/**
 * The picker's list is derived from what the adapters can actually be asked for, and this
 * file is what keeps it derived. Adding a currency because it looks useful, without a way
 * to ask Agoda for it, reproduces issue #158 for whoever picks it: Agoda omits
 * `currency_id`, answers USD, and `resources.ts` drops the bed out of their trip.
 */
describe('SUPPORTED_CURRENCIES', () => {
	it('offers nothing Agoda cannot be asked for', () => {
		for (const currency of SUPPORTED_CURRENCIES) {
			// USD is the one exception, and only because it is Agoda's own implicit default
			// when the parameter is omitted, so it needs no id to arrive correctly.
			if (currency.code === 'USD') continue;
			expect(AGODA_CURRENCY_IDS[currency.code], `${currency.code} has no Agoda currency_id`).toBeTypeOf('number');
		}
	});

	it('offers every currency Agoda can be asked for, now that nothing is mis-scaled', () => {
		// JPY and HUF used to be held back because three adapters disagreed about their
		// minor units (issue #179). One table answers that now, so the picker offers Agoda's
		// whole set rather than the subset whose scaling we happened to agree on.
		const offered = SUPPORTED_CURRENCIES.map((currency) => currency.code);
		expect(offered).toContain('JPY');
		expect(offered).toContain('HUF');
		for (const code of Object.keys(AGODA_CURRENCY_IDS)) {
			expect(offered, `${code} has an Agoda id but no tile`).toContain(code);
		}
	});

	it('knows the right minor-unit exponent for every currency it offers', () => {
		// Written out rather than derived, because deriving it is what #179 was about. The
		// yen has no minor unit and the forint has two, whatever a given browser's currency
		// data happens to say about the forint this year (domain/money.ts).
		const expected: Record<string, number> = {
			EUR: 2,
			GBP: 2,
			USD: 2,
			CHF: 2,
			DKK: 2,
			SEK: 2,
			NOK: 2,
			PLN: 2,
			CZK: 2,
			AUD: 2,
			NZD: 2,
			SGD: 2,
			JPY: 0,
			HUF: 2
		};
		for (const currency of SUPPORTED_CURRENCIES) {
			expect(currencyExponent(currency.code), currency.code).toBe(expected[currency.code]);
		}
	});

	it('names every currency with a well-formed code and no blank display fields', () => {
		for (const currency of SUPPORTED_CURRENCIES) {
			expect(currency.code).toMatch(/^[A-Z]{3}$/);
			expect(currency.name.length).toBeGreaterThan(0);
			expect(currency.symbol.length).toBeGreaterThan(0);
		}
	});

	it('lists each code once', () => {
		const codes = SUPPORTED_CURRENCIES.map((currency) => currency.code);
		expect(new Set(codes).size).toBe(codes.length);
	});

	it('leads with EUR, which is where a search lands when nobody has chosen', () => {
		expect(SUPPORTED_CURRENCIES[0]?.code).toBe('EUR');
	});

	it('stays short enough to render as tiles rather than a dropdown nobody scrolls', () => {
		expect(SUPPORTED_CURRENCIES.length).toBeLessThanOrEqual(16);
	});
});

describe('currencyOptions', () => {
	it('is just the catalogue when nothing is saved', () => {
		expect(currencyOptions(undefined)).toBe(SUPPORTED_CURRENCIES);
	});

	it('is just the catalogue when the saved code is one it already carries', () => {
		expect(currencyOptions('GBP')).toBe(SUPPORTED_CURRENCIES);
	});

	it('adds a tile for a saved code it does not carry, rather than showing the wrong one selected', () => {
		// A key file from a newer build can name a currency this release does not offer. The
		// searches will use it either way, so the screen has to admit it.
		const options = currencyOptions('THB');
		expect(options).toHaveLength(SUPPORTED_CURRENCIES.length + 1);
		expect(options.at(-1)?.code).toBe('THB');
		expect(options.filter((option) => option.code === 'THB')).toHaveLength(1);
	});
});

describe('findCurrency', () => {
	it('finds a listed currency and returns nothing for an unlisted one', () => {
		expect(findCurrency('CZK')?.name).toBe('Czech koruna');
		expect(findCurrency('THB')).toBeUndefined();
	});
});
