import { MemoryCacheStore } from '../../cache';
import { describe, expect, it, vi } from 'vitest';
import { getCachedAirportEntity, setCachedAirportEntity } from './skyscanner-airport-cache';

describe('skyscanner airport entity cache', () => {
	it('is a miss before anything has been stored', async () => {
		const store = new MemoryCacheStore();
		expect(await getCachedAirportEntity('BCN', store)).toBeUndefined();
	});

	it('returns exactly what was stored, keyed by IATA code', async () => {
		const store = new MemoryCacheStore();
		await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, store);
		expect(await getCachedAirportEntity('BCN', store)).toEqual({
			skyId: 'BCN',
			entityId: '95565085'
		});
	});

	it('is case-insensitive on the IATA code', async () => {
		const store = new MemoryCacheStore();
		await setCachedAirportEntity('bcn', { skyId: 'BCN', entityId: '95565085' }, store);
		expect(await getCachedAirportEntity('BCN', store)).toEqual({
			skyId: 'BCN',
			entityId: '95565085'
		});
	});

	it('does not confuse two different airports', async () => {
		const store = new MemoryCacheStore();
		await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, store);
		await setCachedAirportEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, store);
		expect(await getCachedAirportEntity('VIE', store)).toEqual({
			skyId: 'VIE',
			entityId: '95673444'
		});
	});

	it('treats an entry past its TTL as a miss rather than serving a stale entity forever', async () => {
		const store = new MemoryCacheStore();
		vi.useFakeTimers();
		try {
			await setCachedAirportEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, store);
			// Six months plus a day: past the ~180-day TTL this module deliberately keeps
			// long (issue #5: "cache this hard, it essentially never changes").
			vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 181);
			expect(await getCachedAirportEntity('BCN', store)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
