import { describe, expect, it } from 'vitest';
import {
	getCheapRoutesFrom,
	loadCheapRoutes,
	loadCheapRoutesDataset,
	moneyFromMajorUnits
} from './cheap-routes';

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

describe('loadCheapRoutesDataset', () => {
	// Issue #169: the committed artefact itself is the thing under test here. The
	// generator writes this stamp (scripts/fetch-cheap-routes.mjs) and
	// search/providers-adapter.ts reports it as the data's age; before this existed the
	// adapter answered "when was this fetched" with `new Date()`, so a dataset compiled
	// into the bundle weeks earlier claimed to be seconds old.
	it('ships a parseable ISO fetch instant', async () => {
		const dataset = await loadCheapRoutesDataset();
		expect(typeof dataset.fetchedAt).toBe('string');
		expect(Number.isNaN(Date.parse(dataset.fetchedAt))).toBe(false);
	});

	it('reports an instant in the past, never "now"', async () => {
		// The one assertion that would have caught the original bug: a build-time
		// dataset cannot honestly have been fetched during this test run.
		const dataset = await loadCheapRoutesDataset();
		expect(Date.parse(dataset.fetchedAt)).toBeLessThan(Date.now());
	});

	it('carries the routes and the instant on one object, memoized together', async () => {
		const first = await loadCheapRoutesDataset();
		const second = await loadCheapRoutesDataset();
		expect(second).toBe(first);
		expect(first.routes.length).toBeGreaterThan(0);
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
