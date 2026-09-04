import { describe, expect, it } from 'vitest';
import { formatMoney, moneyDifference, stayTotalDelta, stayTotalForNights } from './pricing';

const eur = (minorUnits: number) => ({ minorUnits, currency: 'EUR' });

describe('stayTotalForNights', () => {
	it('multiplies the nightly price by the nights, with no traveller multiplier', () => {
		expect(stayTotalForNights(eur(3000), 3)).toEqual(eur(9000));
	});

	it('floors at zero for a day stopover with no overnight (nights <= 0)', () => {
		expect(stayTotalForNights(eur(3000), 0)).toEqual(eur(0));
		expect(stayTotalForNights(eur(3000), -1)).toEqual(eur(0));
	});
});

describe('moneyDifference', () => {
	it('subtracts previous from next', () => {
		expect(moneyDifference(eur(1000), eur(1500))).toEqual(eur(500));
	});

	it('throws on a currency mismatch rather than guessing an exchange rate', () => {
		expect(() => moneyDifference(eur(1000), { minorUnits: 1000, currency: 'USD' })).toThrow(/currenc/i);
	});
});

describe('stayTotalDelta - issue #27\'s acceptance test', () => {
	it('changes the itinerary total by exactly the per-night difference times the nights', () => {
		// Dorm 18 EUR/night, private 42 EUR/night, 3 nights.
		const dorm = eur(1800);
		const priv = eur(4200);
		const nights = 3;
		const delta = stayTotalDelta(dorm, priv, nights);
		expect(delta).toEqual(eur((4200 - 1800) * nights));
	});

	it('is the exact difference the itinerary total changes by when switching either direction', () => {
		const dorm = eur(2500);
		const priv = eur(9000);
		const nights = 2;
		const up = stayTotalDelta(dorm, priv, nights);
		const down = stayTotalDelta(priv, dorm, nights);
		expect(up.minorUnits).toBe(-down.minorUnits);
		// The itinerary total before/after must actually differ by this delta - not just
		// an isolated number that happens to look right.
		const totalBefore = 500000 + stayTotalForNights(dorm, nights).minorUnits;
		const totalAfter = 500000 + stayTotalForNights(priv, nights).minorUnits;
		expect(totalAfter - totalBefore).toBe(up.minorUnits);
	});

	it('is zero nights times the difference (zero) for a day stopover', () => {
		expect(stayTotalDelta(eur(1800), eur(4200), 0)).toEqual(eur(0));
	});
});

describe('formatMoney', () => {
	it('formats EUR with two decimal places', () => {
		expect(formatMoney(eur(1850))).toContain('18.50');
	});

	it('formats a zero-decimal currency (JPY) without inventing decimal places', () => {
		expect(formatMoney({ minorUnits: 1500, currency: 'JPY' })).not.toContain('.');
	});
});
