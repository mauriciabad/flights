import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../cache';
import type { CacheStore } from '../cache';
import { ledgerCacheKey, readLedgerMonths, recordLedgerFares } from './observations';
import type { LegKey } from './observations';
import type { DayFare } from './types';

const NOW = Date.UTC(2026, 8, 4, 12);
const DAY = 24 * 60 * 60_000;
const leg: LegKey = { origin: 'BVC', destination: 'LGW', currency: 'EUR' };

let store: CacheStore;

function fare(overrides: Partial<DayFare> = {}): DayFare {
	return {
		departureDate: '2026-10-01',
		arrivalDate: '2026-10-01',
		minorUnits: 12_300,
		providerId: 'kiwi-public',
		observedAt: NOW - DAY,
		...overrides
	};
}

beforeEach(() => {
	store = new MemoryCacheStore();
});

describe('the price ledger', () => {
	it('round-trips a fare through the shared cache store', async () => {
		await recordLedgerFares(leg, [fare()], { store });
		await expect(readLedgerMonths(leg, ['2026-10-01'], { store, now: NOW })).resolves.toEqual([
			fare()
		]);
	});

	it('keeps legs and currencies apart', async () => {
		await recordLedgerFares(leg, [fare()], { store });

		await expect(
			readLedgerMonths({ ...leg, destination: 'PFO' }, ['2026-10-01'], { store, now: NOW })
		).resolves.toEqual([]);
		await expect(
			readLedgerMonths({ ...leg, currency: 'GBP' }, ['2026-10-01'], { store, now: NOW })
		).resolves.toEqual([]);
	});

	it('files a fare under the month it departs in', async () => {
		await recordLedgerFares(leg, [fare({ departureDate: '2026-11-30', arrivalDate: '2026-12-01' })], {
			store
		});

		await expect(readLedgerMonths(leg, ['2026-10-01'], { store, now: NOW })).resolves.toEqual([]);
		await expect(readLedgerMonths(leg, ['2026-11-01'], { store, now: NOW })).resolves.toHaveLength(1);
	});

	// A price is a fact at a time. Keeping the older, cheaper number because it flatters the
	// ranking is the exact dishonesty this feature cannot afford.
	it('lets a newer observation from the same source replace an older, cheaper one', async () => {
		await recordLedgerFares(leg, [fare({ minorUnits: 5000, observedAt: NOW - 3 * DAY })], { store });
		await recordLedgerFares(leg, [fare({ minorUnits: 9000, observedAt: NOW - DAY })], { store });

		const fares = await readLedgerMonths(leg, ['2026-10-01'], { store, now: NOW });

		expect(fares).toHaveLength(1);
		expect(fares[0].minorUnits).toBe(9000);
	});

	it('ignores an older observation arriving after a newer one', async () => {
		await recordLedgerFares(leg, [fare({ minorUnits: 9000, observedAt: NOW - DAY })], { store });
		await recordLedgerFares(leg, [fare({ minorUnits: 5000, observedAt: NOW - 3 * DAY })], { store });

		const fares = await readLedgerMonths(leg, ['2026-10-01'], { store, now: NOW });
		expect(fares[0].minorUnits).toBe(9000);
	});

	it('keeps one entry per source for the same day', async () => {
		await recordLedgerFares(leg, [fare({ providerId: 'kiwi-public', minorUnits: 9000 })], { store });
		await recordLedgerFares(leg, [fare({ providerId: 'ryanair', minorUnits: 4000 })], { store });

		const fares = await readLedgerMonths(leg, ['2026-10-01'], { store, now: NOW });

		expect(fares).toHaveLength(2);
		expect(fares.map((f) => f.providerId).sort()).toEqual(['kiwi-public', 'ryanair']);
	});

	it('hides observations past the age window without deleting them', async () => {
		await recordLedgerFares(leg, [fare({ observedAt: NOW - 90 * DAY })], { store });

		await expect(readLedgerMonths(leg, ['2026-10-01'], { store, now: NOW })).resolves.toEqual([]);
		await expect(
			readLedgerMonths(leg, ['2026-10-01'], { store, now: NOW, maxAgeMs: 365 * DAY })
		).resolves.toHaveLength(1);
	});

	it('survives a store that refuses to write, rather than taking the page down with it', async () => {
		const broken: CacheStore = {
			get: async () => undefined,
			set: async () => {
				throw new Error('QuotaExceededError');
			},
			deleteByProvider: async () => {},
			clear: async () => {}
		};

		await expect(recordLedgerFares(leg, [fare()], { store: broken })).resolves.toBeUndefined();
	});

	// #131's lesson, applied before it can bite: a cached value whose shape changed must not
	// be served back as if it were the new shape.
	it('ignores an entry written in a shape it does not recognise', async () => {
		const key = ledgerCacheKey(leg, '2026-10-01');
		const now = Date.now();
		await store.set({
			key: key.raw,
			providerId: 'flexible-dates',
			value: { version: 99, days: { '2026-10-01': [{ minorUnits: 1 }] } },
			storedAt: now,
			ttlMs: key.ttlMs,
			lastAccessedAt: now,
			sizeBytes: 10
		});

		await expect(readLedgerMonths(leg, ['2026-10-01'], { store, now: NOW })).resolves.toEqual([]);
	});
});
