import { describe, expect, it } from 'vitest';
import { AGODA_CURRENCY_INFO } from '../providers/stays/agoda-mapper';
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
			const agoda = AGODA_CURRENCY_INFO[currency.code];
			expect(agoda, `${currency.code} has no entry in Agoda's currency table`).toBeDefined();
			// USD is the one exception, and only because it is Agoda's own implicit default
			// when the parameter is omitted, so it needs no id to arrive correctly.
			if (currency.code !== 'USD') {
				expect(agoda?.id, `${currency.code} has no Agoda currency_id`).toBeTypeOf('number');
			}
		}
	});

	it('offers nothing whose minor units two adapters disagree about', () => {
		// JPY has no minor unit at all, and `booking-mapper.ts` multiplies every price by 100
		// regardless. HUF is worse: `ZERO_DECIMAL_CURRENCIES` in `skyscanner-money.ts` and
		// `flights-sky-money.ts` treats it as having none while Agoda's own table gives it
		// two. Either would put a flight and a bed a factor of 100 apart in one total, so
		// they stay out of the picker until issue #179 settles it.
		for (const currency of SUPPORTED_CURRENCIES) {
			expect(AGODA_CURRENCY_INFO[currency.code]?.minorUnitDigits).toBe(2);
		}
		expect(SUPPORTED_CURRENCIES.map((c) => c.code)).not.toContain('JPY');
		expect(SUPPORTED_CURRENCIES.map((c) => c.code)).not.toContain('HUF');
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
		const options = currencyOptions('JPY');
		expect(options).toHaveLength(SUPPORTED_CURRENCIES.length + 1);
		expect(options.at(-1)?.code).toBe('JPY');
		expect(options.filter((option) => option.code === 'JPY')).toHaveLength(1);
	});
});

describe('findCurrency', () => {
	it('finds a listed currency and returns nothing for an unlisted one', () => {
		expect(findCurrency('CZK')?.name).toBe('Czech koruna');
		expect(findCurrency('JPY')).toBeUndefined();
	});
});
