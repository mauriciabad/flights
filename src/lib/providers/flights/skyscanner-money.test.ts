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

	it('treats a zero-decimal currency as having no minor unit at all', () => {
		expect(parseOfferPrice({ raw: 2500 }, 'JPY')).toEqual({ minorUnits: 2500, currency: 'JPY' });
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
