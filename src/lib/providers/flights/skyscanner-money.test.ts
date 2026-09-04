import { describe, expect, it } from 'vitest';
import { parseOfferPrice } from './skyscanner-money';

describe('parseOfferPrice', () => {
	it('uses raw when it is a finite number, in minor units', () => {
		expect(parseOfferPrice({ raw: 17.99, formatted: '18 €' }, 'EUR')).toEqual({
			minorUnits: 1799,
			currency: 'EUR'
		});
	});

	it('rounds a raw value that does not land on a whole cent', () => {
		expect(parseOfferPrice({ raw: 102.005 }, 'EUR')).toEqual({
			minorUnits: 10201,
			currency: 'EUR'
		});
	});

	// Issue #179. This adapter used to hold its own six-code zero-decimal list, byte-
	// identical to flights-sky-money.ts's and wrong about HUF in both: a 45000.00 forint
	// fare parsed as 45000 minor units, a hundredth of the real price. The exponent comes
	// from domain/money.ts now, so no two adapters can answer differently.
	it('treats a zero-decimal currency as having no minor unit at all', () => {
		expect(parseOfferPrice({ raw: 2500 }, 'JPY')).toEqual({ minorUnits: 2500, currency: 'JPY' });
	});

	it('treats the forint as the two-decimal currency it is', () => {
		expect(parseOfferPrice({ raw: 45000 }, 'HUF')).toEqual({ minorUnits: 4500000, currency: 'HUF' });
	});

	it('gives a three-decimal dinar three', () => {
		expect(parseOfferPrice({ raw: 1.5 }, 'KWD')).toEqual({ minorUnits: 1500, currency: 'KWD' });
	});

	it('falls back to parsing the formatted string when raw is missing', () => {
		expect(parseOfferPrice({ formatted: '18 €' }, 'EUR')).toEqual({
			minorUnits: 1800,
			currency: 'EUR'
		});
	});

	it('falls back to the formatted string when raw is a non-numeric value', () => {
		expect(parseOfferPrice({ raw: 'unknown', formatted: '$1,234.50' }, 'USD')).toEqual({
			minorUnits: 123450,
			currency: 'USD'
		});
	});

	it('returns undefined rather than a fabricated price when nothing parses', () => {
		expect(parseOfferPrice({}, 'EUR')).toBeUndefined();
		expect(parseOfferPrice(undefined, 'EUR')).toBeUndefined();
		expect(parseOfferPrice({ formatted: 'call for price' }, 'EUR')).toBeUndefined();
	});

	it('rejects a negative price rather than treating it as valid', () => {
		expect(parseOfferPrice({ raw: -5 }, 'EUR')).toBeUndefined();
	});
});
