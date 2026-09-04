import { describe, expect, it } from 'vitest';
import { parseItineraryPrice } from './flights-sky-money';

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

	// Issue #179. This adapter used to hold its own copy of a zero-decimal currency list,
	// byte-identical to skyscanner-money.ts's and wrong about HUF in both. The exponent now
	// comes from domain/money.ts, so the two adapters cannot answer differently.
	it('scales by the currency rather than always by 100', () => {
		expect(parseItineraryPrice({ raw: 12000 }, 'JPY')).toEqual({ minorUnits: 12000, currency: 'JPY' });
		expect(parseItineraryPrice({ raw: 45000 }, 'HUF')).toEqual({ minorUnits: 4500000, currency: 'HUF' });
		expect(parseItineraryPrice({ raw: 1.5 }, 'KWD')).toEqual({ minorUnits: 1500, currency: 'KWD' });
	});

	it('reads a HUF price out of the formatted string at the same scale as out of raw', () => {
		// English-style separators, which is the only shape this fallback claims to read —
		// a Hungarian-formatted "45 000,00 Ft" would be misread by a factor of 100, and that
		// is the fallback's own long-standing limitation rather than the exponent's.
		expect(parseItineraryPrice({ formatted: '45,000.00 Ft' }, 'HUF')?.minorUnits).toBe(4500000);
	});
});
