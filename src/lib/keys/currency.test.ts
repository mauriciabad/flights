import { describe, expect, it } from 'vitest';
import { isWellFormedCurrencyCode, normalizeCurrencyCode } from './currency';

describe('isWellFormedCurrencyCode', () => {
	it('accepts three uppercase letters', () => {
		expect(isWellFormedCurrencyCode('EUR')).toBe(true);
		expect(isWellFormedCurrencyCode('ZZZ')).toBe(true);
	});

	it('rejects anything that is not exactly three uppercase letters', () => {
		expect(isWellFormedCurrencyCode('eur')).toBe(false);
		expect(isWellFormedCurrencyCode('EU')).toBe(false);
		expect(isWellFormedCurrencyCode('EURO')).toBe(false);
		expect(isWellFormedCurrencyCode('E0R')).toBe(false);
		expect(isWellFormedCurrencyCode('')).toBe(false);
	});
});

describe('normalizeCurrencyCode', () => {
	it('trims and uppercases what a person or a hand-edited file might write', () => {
		expect(normalizeCurrencyCode(' gbp ')).toBe('GBP');
		expect(normalizeCurrencyCode('Chf')).toBe('CHF');
	});

	it('reads anything malformed as nothing saved, so the caller falls back to the default', () => {
		expect(normalizeCurrencyCode('euros')).toBeUndefined();
		expect(normalizeCurrencyCode('')).toBeUndefined();
		expect(normalizeCurrencyCode('   ')).toBeUndefined();
		expect(normalizeCurrencyCode(null)).toBeUndefined();
		expect(normalizeCurrencyCode(undefined)).toBeUndefined();
		expect(normalizeCurrencyCode(42)).toBeUndefined();
		expect(normalizeCurrencyCode({ code: 'EUR' })).toBeUndefined();
	});

	it('keeps a well-formed code the picker does not offer', () => {
		// A key file from a newer build, or one somebody edited by hand. Dropping it would
		// silently move their searches to EUR while the setting looked untouched.
		expect(normalizeCurrencyCode('JPY')).toBe('JPY');
	});
});
