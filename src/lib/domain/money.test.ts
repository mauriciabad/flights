/**
 * Issue #179: three adapters each answered "how many decimal digits does this currency
 * have" for themselves, and they disagreed. Two flight adapters called the forint a
 * zero-decimal currency (a 45000.00 HUF fare became 450.00 HUF), Agoda's own captured table
 * called it a two-decimal one, and Booking multiplied every price by 100 whatever the
 * currency was (a 12000 JPY room became 1,200,000 JPY). This file is where that question
 * gets its one answer.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMoney } from '$lib/format';
import {
	currencyExponent,
	majorUnitsOf,
	minorUnitsPerMajorUnit,
	moneyFromDecimalString,
	moneyFromFormattedString,
	moneyFromMajorUnits
} from './money';

/** ISO 4217's own exponents, written out here independently of the table under test, so
 * this file is a spec rather than a mirror. Everything not listed has two digits. */
const ISO_ZERO_DECIMAL =
	'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF'.split(' ');
const ISO_THREE_DECIMAL = 'BHD IQD JOD KWD LYD OMR TND'.split(' ');
const ISO_FOUR_DECIMAL = 'CLF UYW'.split(' ');

function intlFractionDigits(currency: string): number {
	const { minimumFractionDigits } = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions();
	return minimumFractionDigits ?? 2;
}

describe('currencyExponent', () => {
	it('gives the euro two digits, the yen none, and the Kuwaiti dinar three', () => {
		expect(currencyExponent('EUR')).toBe(2);
		expect(currencyExponent('JPY')).toBe(0);
		expect(currencyExponent('KWD')).toBe(3);
	});

	it('gives the forint two, which is the disagreement this issue is about', () => {
		// The flight adapters had HUF in a zero-decimal set, so a 45000.00 HUF fare parsed
		// as 45000 minor units — 450.00 HUF, a hundredth of the real fare — while Agoda's
		// own /currencies capture said two digits for the same currency.
		expect(currencyExponent('HUF')).toBe(2);
	});

	it('gives every ISO 4217 zero-decimal currency none', () => {
		for (const code of ISO_ZERO_DECIMAL) expect(currencyExponent(code), code).toBe(0);
	});

	it('gives every ISO 4217 three-decimal currency three', () => {
		for (const code of ISO_THREE_DECIMAL) expect(currencyExponent(code), code).toBe(3);
	});

	it('gives the two indexed accounting units four', () => {
		for (const code of ISO_FOUR_DECIMAL) expect(currencyExponent(code), code).toBe(4);
	});

	it('gives cents to everything else, including currencies CLDR rounds to whole units', () => {
		// CLDR gives the lek, the Lebanese pound and the rupiah no minor unit because nobody
		// quotes one in practice. ISO gives them two, and following ISO is what keeps the
		// forint at two on a runtime whose currency data says otherwise (see below).
		for (const code of ['EUR', 'USD', 'GBP', 'HUF', 'ALL', 'LBP', 'IDR', 'COP', 'PKR', 'RSD']) {
			expect(currencyExponent(code), code).toBe(2);
		}
	});

	it('assumes cents for a code it has never heard of, rather than throwing', () => {
		// A key file can carry any well-formed code, and a provider can echo one back.
		expect(currencyExponent('ZZZ')).toBe(2);
	});

	it('reads a code whatever case and padding it arrives in', () => {
		expect(currencyExponent('jpy')).toBe(0);
		expect(currencyExponent(' Jpy ')).toBe(0);
	});

	/**
	 * The reason the table is hardcoded rather than read off `Intl`, which is what #179
	 * suggested. This branch's first CI run (actions/runs/33904155492) failed exactly here:
	 * Node 22 answered 0 for the forint and Node 25 answered 2, along with four other codes.
	 * Deriving the exponent would have made the same fare parse a hundred times apart on two
	 * runtimes, which is the bug being fixed, reintroduced by the fix.
	 *
	 * So this asserts the property that survives the disagreement instead: whatever this
	 * runtime's currency data says, a forint price parses and prints at one scale. On a
	 * runtime that reads 0 here, the second assertion is what fails without `format.ts`
	 * passing the digit count in.
	 */
	it('does not defer to Intl, whose answer for the forint depends on the runtime', () => {
		expect(currencyExponent('HUF')).toBe(2);
		expect([0, 2]).toContain(intlFractionDigits('HUF'));

		const fare = moneyFromDecimalString('45000.00', 'HUF');
		expect(fare).toEqual({ minorUnits: 4500000, currency: 'HUF' });
		expect(fare && formatMoney(fare)).toBe('Ft\u00a045,000.00');
	});
});

describe('minorUnitsPerMajorUnit', () => {
	it('is the divisor, not the digit count', () => {
		expect(minorUnitsPerMajorUnit('EUR')).toBe(100);
		expect(minorUnitsPerMajorUnit('JPY')).toBe(1);
		expect(minorUnitsPerMajorUnit('KWD')).toBe(1000);
	});
});

describe('moneyFromMajorUnits', () => {
	it('scales by the currency, not by a hardcoded 100', () => {
		expect(moneyFromMajorUnits(19.99, 'EUR')).toEqual({ minorUnits: 1999, currency: 'EUR' });
		expect(moneyFromMajorUnits(12000, 'JPY')).toEqual({ minorUnits: 12000, currency: 'JPY' });
		expect(moneyFromMajorUnits(45000, 'HUF')).toEqual({ minorUnits: 4500000, currency: 'HUF' });
		expect(moneyFromMajorUnits(1.5, 'KWD')).toEqual({ minorUnits: 1500, currency: 'KWD' });
	});

	it('rounds away the binary-float error instead of truncating it', () => {
		// The trap by name: 19.99 * 100 is 1998.9999999999998 in IEEE 754, and a cast to an
		// integer would undercharge by a cent.
		expect(19.99 * 100).toBeCloseTo(1998.9999999999998, 10);
		expect(moneyFromMajorUnits(19.99, 'EUR')?.minorUnits).toBe(1999);
		expect(moneyFromMajorUnits(1.005, 'KWD')?.minorUnits).toBe(1005);
	});

	it('rounds a fraction a zero-decimal currency cannot hold', () => {
		expect(moneyFromMajorUnits(12000.6, 'JPY')).toEqual({ minorUnits: 12001, currency: 'JPY' });
	});

	it('stores the code trimmed and upper-cased, so two prices in one currency add up', () => {
		expect(moneyFromMajorUnits(10, 'eur')?.currency).toBe('EUR');
		expect(moneyFromMajorUnits(10, ' eur ')?.currency).toBe('EUR');
	});

	it.each([
		['undefined', undefined],
		['null', null],
		['a numeric string', '34.0'],
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['a negative price', -5],
		['an object', {}],
		['a boolean', true]
	])('returns undefined for %s rather than a fabricated price', (_label, value) => {
		// `null * 100` is 0 in JavaScript, not an error: an unchecked missing price becomes
		// a real, wrong, free one.
		expect(moneyFromMajorUnits(value, 'EUR')).toBeUndefined();
	});

	it.each([
		['undefined', undefined],
		['an empty string', ''],
		['whitespace', '   '],
		['a number', 978],
		['a name rather than a code', 'euros'],
		['two letters', 'EU'],
		['a symbol', '€']
	])('returns undefined for %s as the currency', (_label, currency) => {
		// Anything Intl would throw a RangeError on has to be dropped here, at the edge,
		// rather than taken as far as the results page and rendered.
		expect(moneyFromMajorUnits(10, currency)).toBeUndefined();
	});

	it('refuses an amount too large to hold as an exact integer', () => {
		expect(moneyFromMajorUnits(1e17, 'EUR')).toBeUndefined();
	});
});

describe('moneyFromDecimalString', () => {
	it('reads the digits rather than going through a float', () => {
		expect(moneyFromDecimalString('173', 'EUR')).toEqual({ minorUnits: 17300, currency: 'EUR' });
		expect(moneyFromDecimalString('14.99', 'EUR')).toEqual({ minorUnits: 1499, currency: 'EUR' });
	});

	it('pads a single decimal place rather than reading it as cents', () => {
		expect(moneyFromDecimalString('20.5', 'EUR')).toEqual({ minorUnits: 2050, currency: 'EUR' });
	});

	it('splits at the currency exponent, not always at two digits', () => {
		// The same "45000.00" a provider quotes a Budapest fare in: 45000 forints, not 450.
		expect(moneyFromDecimalString('45000.00', 'HUF')).toEqual({ minorUnits: 4500000, currency: 'HUF' });
		expect(moneyFromDecimalString('12000', 'JPY')).toEqual({ minorUnits: 12000, currency: 'JPY' });
		expect(moneyFromDecimalString('1.500', 'KWD')).toEqual({ minorUnits: 1500, currency: 'KWD' });
		expect(moneyFromDecimalString('1.5', 'KWD')).toEqual({ minorUnits: 1500, currency: 'KWD' });
	});

	it('rounds digits the currency cannot hold instead of dropping them', () => {
		expect(moneyFromDecimalString('19.999', 'EUR')?.minorUnits).toBe(2000);
		expect(moneyFromDecimalString('19.994', 'EUR')?.minorUnits).toBe(1999);
		expect(moneyFromDecimalString('12000.6', 'JPY')?.minorUnits).toBe(12001);
		expect(moneyFromDecimalString('12000.4', 'JPY')?.minorUnits).toBe(12000);
	});

	it('reads a whole amount with no decimal point at all', () => {
		expect(moneyFromDecimalString('0', 'EUR')).toEqual({ minorUnits: 0, currency: 'EUR' });
	});

	it('uppercases the currency code', () => {
		expect(moneyFromDecimalString('10', 'eur')?.currency).toBe('EUR');
	});

	it.each([
		['a missing amount', undefined],
		['a number instead of a string', 173],
		['a thousands separator', '1,173'],
		['scientific notation', '1.73e2'],
		['a negative amount', '-173'],
		['a trailing point', '173.'],
		['a currency symbol', '€173'],
		['an empty string', '']
	])('refuses %s rather than producing NaN', (_label, amount) => {
		expect(moneyFromDecimalString(amount, 'EUR')).toBeUndefined();
	});

	it('refuses a missing currency', () => {
		expect(moneyFromDecimalString('173', undefined)).toBeUndefined();
	});
});

describe('majorUnitsOf', () => {
	it('divides by the currency exponent, the exact inverse of parsing', () => {
		expect(majorUnitsOf({ minorUnits: 1999, currency: 'EUR' })).toBe(19.99);
		expect(majorUnitsOf({ minorUnits: 12000, currency: 'JPY' })).toBe(12000);
		expect(majorUnitsOf({ minorUnits: 4500000, currency: 'HUF' })).toBe(45000);
		expect(majorUnitsOf({ minorUnits: 1500, currency: 'KWD' })).toBe(1.5);
	});
});

/**
 * The acceptance test in the issue's own words: the number a provider sent is the number a
 * traveller reads back. Both halves scale through the same table, so this cannot pass by
 * accident of them being wrong in the same direction — a wrong exponent moves the decimal
 * point in the rendered string.
 */
describe('a price survives the trip from a provider response to the screen', () => {
	// `\u00a0` is the non-breaking space Intl puts between a symbol and its amount when the
	// symbol goes in front and is more than one character wide.
	it.each([
		['45000.00', 'HUF', 'Ft\u00a045,000.00'],
		['12000', 'JPY', '¥12,000'],
		['19.99', 'EUR', '€19.99'],
		['1.500', 'KWD', 'KWD\u00a01.500'],
		['173', 'USD', '$173.00']
	])('reads %s %s back as %s', (amount, currency, formatted) => {
		const money = moneyFromDecimalString(amount, currency);
		expect(money).toBeDefined();
		expect(money && formatMoney(money)).toBe(formatted);
	});

	it('is the same number whether the provider sent a string or a float', () => {
		expect(moneyFromMajorUnits(45000, 'HUF')).toEqual(moneyFromDecimalString('45000.00', 'HUF'));
		expect(moneyFromMajorUnits(12000, 'JPY')).toEqual(moneyFromDecimalString('12000', 'JPY'));
	});
});

/**
 * The structural half of the fix. Three modules each grew their own answer to "how many
 * minor units does this currency have" because nothing stopped a fourth from doing the
 * same, and a wrong one is invisible until a traveller sees a Budapest hotel priced like a
 * car. This fails the build instead.
 *
 * The rule is narrow on purpose: a literal 100 on the same line as `minorUnits` is a
 * currency assumption written by hand. Multiplying a price by a passenger count or a night
 * count is not, and neither trips this.
 */
describe('nothing outside this module scales money by a hardcoded 100', () => {
	function sourceFiles(directory: string): string[] {
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			if (entry.name.endsWith('.test.ts') || entry.name === 'money.ts') return [];
			return /\.(ts|svelte)$/.test(entry.name) ? [path] : [];
		});
	}

	it('leaves every currency exponent to currencyExponent', () => {
		const offenders: string[] = [];
		for (const path of sourceFiles('src')) {
			readFileSync(path, 'utf8')
				.split('\n')
				.forEach((line, index) => {
					if (/minorUnits.*[*/]\s*100\b|[*/]\s*100\b.*minorUnits/.test(line)) {
						offenders.push(`${path}:${index + 1}: ${line.trim()}`);
					}
				});
		}
		expect(
			offenders,
			'use moneyFromMajorUnits / moneyFromDecimalString / majorUnitsOf (domain/money.ts) instead'
		).toEqual([]);
	});
});

/**
 * Issue #192. Both Sky Scrapper adapters read a display string by stripping everything but
 * digits, a dot and a comma and then deleting the commas, which reads a comma decimal
 * separator as a thousands separator. "60,99 €" came out as 6099 euros.
 *
 * The four shapes the issue names as acceptance are the first case below. Everything after
 * it is a shape that has to be refused rather than guessed at, which is the half of this
 * function that stops the next locale producing the same bug.
 */
describe('moneyFromFormattedString', () => {
	it('reads the four shapes issue #192 names', () => {
		expect(moneyFromFormattedString('18 €', 'EUR')).toEqual({ minorUnits: 1800, currency: 'EUR' });
		expect(moneyFromFormattedString('$1,234.50', 'USD')).toEqual({ minorUnits: 123450, currency: 'USD' });
		expect(moneyFromFormattedString('60,99 €', 'EUR')).toEqual({ minorUnits: 6099, currency: 'EUR' });
		expect(moneyFromFormattedString('45 000,00 Ft', 'HUF')).toEqual({ minorUnits: 4500000, currency: 'HUF' });
	});

	it('never reads a comma decimal separator as a hundredfold', () => {
		expect(majorUnitsOf(moneyFromFormattedString('60,99 €', 'EUR')!)).toBe(60.99);
		expect(majorUnitsOf(moneyFromFormattedString('45 000,00 Ft', 'HUF')!)).toBe(45000);
	});

	it('reads the group separators real currency formatters emit', () => {
		// The non-breaking and narrow no-break spaces `Intl` itself emits, which a plain
		// / /g would leave sitting in among the digits.
		expect(moneyFromFormattedString('45 000,00 Ft', 'HUF')?.minorUnits).toBe(4500000);
		expect(moneyFromFormattedString('1 234,56 €', 'EUR')?.minorUnits).toBe(123456);
		expect(moneyFromFormattedString('1.234,56 €', 'EUR')?.minorUnits).toBe(123456);
		expect(moneyFromFormattedString('1,234,567 ¥', 'JPY')?.minorUnits).toBe(1234567);
	});

	it('takes the later separator as the decimal point when both are present', () => {
		expect(majorUnitsOf(moneyFromFormattedString('1,234.50', 'EUR')!)).toBe(1234.5);
		expect(majorUnitsOf(moneyFromFormattedString('1.234,50', 'EUR')!)).toBe(1234.5);
	});

	it('groups a lone separator with three digits behind it, unless a dinar makes that ambiguous', () => {
		// ".500" is not a shape a two-decimal currency has, so it can only be grouping.
		expect(moneyFromFormattedString('1,500 €', 'EUR')?.minorUnits).toBe(150000);
		// For a three-decimal currency both readings exist and disagree, so neither is taken.
		expect(moneyFromFormattedString('1,500 KWD', 'KWD')).toBeUndefined();
	});

	it('refuses a string that does not pin down exactly one amount', () => {
		expect(moneyFromFormattedString('18 € - 24 €', 'EUR')).toBeUndefined();
		expect(moneyFromFormattedString('call for price', 'EUR')).toBeUndefined();
		expect(moneyFromFormattedString('12,34,567', 'EUR')).toBeUndefined();
		expect(moneyFromFormattedString('1,2345', 'EUR')).toBeUndefined();
		expect(moneyFromFormattedString('-60,99 €', 'EUR')).toBeUndefined();
		expect(moneyFromFormattedString('', 'EUR')).toBeUndefined();
		expect(moneyFromFormattedString('.', 'EUR')).toBeUndefined();
		expect(moneyFromFormattedString(',99 €', 'EUR')).toBeUndefined();
	});

	it('refuses anything that is not a string, and any currency that is not a code', () => {
		expect(moneyFromFormattedString(undefined, 'EUR')).toBeUndefined();
		expect(moneyFromFormattedString(60.99, 'EUR')).toBeUndefined();
		expect(moneyFromFormattedString('18 €', 'EUROS')).toBeUndefined();
		expect(moneyFromFormattedString('18 €', undefined)).toBeUndefined();
	});

	it('normalises the currency code the way every other constructor here does', () => {
		expect(moneyFromFormattedString('18 €', ' eur ')).toEqual({ minorUnits: 1800, currency: 'EUR' });
	});
});
