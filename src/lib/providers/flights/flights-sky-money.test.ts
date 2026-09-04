import { describe, expect, it } from 'vitest';
import { moneyFromMajorUnits, parseItineraryPrice } from './flights-sky-money';

describe('moneyFromMajorUnits', () => {
	it('converts a plain EUR float to integer cents', () => {
		expect(moneyFromMajorUnits(34.0, 'EUR')).toEqual({ minorUnits: 3400, currency: 'EUR' });
	});

	// This issue's brief names the exact trap: `19.99 * 100` is `1998.9999999999998` in
	// JavaScript, not `1999`. Math.round fixes it; a naive truncation would not.
	it('rounds away the binary-float error instead of truncating it', () => {
		expect(19.99 * 100).toBeCloseTo(1998.9999999999998, 10); // documents the trap itself
		expect(moneyFromMajorUnits(19.99, 'EUR')).toEqual({ minorUnits: 1999, currency: 'EUR' });
	});

	it('treats a zero-decimal currency as having no minor unit', () => {
		expect(moneyFromMajorUnits(124, 'JPY')).toEqual({ minorUnits: 124, currency: 'JPY' });
	});

	it('returns undefined for a negative price rather than fabricating one', () => {
		expect(moneyFromMajorUnits(-5, 'EUR')).toBeUndefined();
	});

	it('returns undefined for a non-finite or non-numeric value', () => {
		expect(moneyFromMajorUnits(Number.NaN, 'EUR')).toBeUndefined();
		expect(moneyFromMajorUnits('34.0', 'EUR')).toBeUndefined();
		expect(moneyFromMajorUnits(undefined, 'EUR')).toBeUndefined();
	});
});

describe('parseItineraryPrice', () => {
	it('prefers the numeric raw field', () => {
		expect(parseItineraryPrice({ raw: 60.99, formatted: '61 €' }, 'EUR')).toEqual({
			minorUnits: 6099,
			currency: 'EUR'
		});
	});

	it('parses raw when it arrives as a numeric string', () => {
		expect(parseItineraryPrice({ raw: '60.99' }, 'EUR')).toEqual({ minorUnits: 6099, currency: 'EUR' });
	});

	it('falls back to the formatted display string when raw is missing', () => {
		expect(parseItineraryPrice({ formatted: '61 €' }, 'EUR')).toEqual({ minorUnits: 6100, currency: 'EUR' });
	});

	it('returns undefined, not a fabricated 0, when neither field parses', () => {
		expect(parseItineraryPrice({}, 'EUR')).toBeUndefined();
		expect(parseItineraryPrice(undefined, 'EUR')).toBeUndefined();
	});
});
