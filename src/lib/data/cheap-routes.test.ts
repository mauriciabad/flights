import { describe, expect, it } from 'vitest';
import { getCheapRoutesFrom, loadCheapRoutes, moneyFromMajorUnits } from './cheap-routes';

describe('moneyFromMajorUnits', () => {
	it('converts euros to cents', () => {
		expect(moneyFromMajorUnits(45, 'eur')).toEqual({ minorUnits: 4500, currency: 'EUR' });
	});

	it('rounds away float error instead of undercharging by a cent', () => {
		// 19.99 * 100 === 1998.9999999999998 in IEEE 754 -- a plain multiply-and-cast
		// would silently drop a cent here.
		expect(moneyFromMajorUnits(19.99, 'eur').minorUnits).toBe(1999);
	});

	it('uppercases the currency code', () => {
		expect(moneyFromMajorUnits(10, 'eur').currency).toBe('EUR');
	});
});

describe('loadCheapRoutes', () => {
	it('resolves an array, memoized across calls', async () => {
		const first = await loadCheapRoutes();
		const second = await loadCheapRoutes();
		expect(Array.isArray(first)).toBe(true);
		expect(second).toBe(first);
	});

	it('gives every route a Money price and an expiresAt, never one without the other', async () => {
		const routes = await loadCheapRoutes();
		for (const route of routes) {
			expect(typeof route.price.minorUnits).toBe('number');
			expect(typeof route.price.currency).toBe('string');
			expect(typeof route.expiresAt).toBe('string');
			expect(route.expiresAt.length).toBeGreaterThan(0);
		}
	});
});

describe('getCheapRoutesFrom', () => {
	it('returns [] rather than throwing for an origin not in the dataset', async () => {
		await expect(getCheapRoutesFrom('ZZZ')).resolves.toEqual([]);
	});

	it('returns [] for a blank origin', async () => {
		await expect(getCheapRoutesFrom('')).resolves.toEqual([]);
	});

	it('only returns routes matching the requested origin', async () => {
		const routes = await getCheapRoutesFrom('BCN');
		for (const route of routes) {
			expect(route.origin).toBe('BCN');
		}
	});
});
