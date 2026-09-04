import { MemoryCacheStore } from '../../cache';
import { describe, expect, it, vi } from 'vitest';
import autoCompleteBarcelona from './fixtures/flights-sky-auto-complete-barcelona.json';
import { extractExactEntityMatch, getCachedEntity, setCachedEntity } from './flights-sky-entity-cache';

describe('flights-sky entity cache', () => {
	it('is a miss before anything has been stored', async () => {
		const store = new MemoryCacheStore();
		expect(await getCachedEntity('BCN', store)).toBeUndefined();
	});

	it('returns exactly what was stored, keyed by IATA code', async () => {
		const store = new MemoryCacheStore();
		await setCachedEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, store);
		expect(await getCachedEntity('BCN', store)).toEqual({ skyId: 'BCN', entityId: '95565085' });
	});

	it('is case-insensitive on the IATA code', async () => {
		const store = new MemoryCacheStore();
		await setCachedEntity('bcn', { skyId: 'BCN', entityId: '95565085' }, store);
		expect(await getCachedEntity('BCN', store)).toEqual({ skyId: 'BCN', entityId: '95565085' });
	});

	it('does not confuse two different airports', async () => {
		const store = new MemoryCacheStore();
		await setCachedEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, store);
		await setCachedEntity('VIE', { skyId: 'VIE', entityId: '95673444' }, store);
		expect(await getCachedEntity('VIE', store)).toEqual({ skyId: 'VIE', entityId: '95673444' });
	});

	it('treats an entry past its TTL as a miss rather than serving a stale entity forever', async () => {
		const store = new MemoryCacheStore();
		vi.useFakeTimers();
		try {
			await setCachedEntity('BCN', { skyId: 'BCN', entityId: '95565085' }, store);
			// Six months plus a day: past the ~180-day TTL this module deliberately keeps long.
			vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 181);
			expect(await getCachedEntity('BCN', store)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('extractExactEntityMatch', () => {
	// Real capture, 2026-09-04: auto-complete?query=barcelona answers with both Barcelona,
	// Spain (skyId "BCN") and Barcelona, Venezuela (skyId "BLA") — the exact trap this issue
	// and docs/PROVIDERS.md call out. Taking the first result would work here only because
	// Spain happens to sort first in this particular response.
	it('picks the entry whose skyId matches exactly, never the first result', () => {
		const entity = extractExactEntityMatch(autoCompleteBarcelona, 'BCN');
		expect(entity).toEqual({ skyId: 'BCN', entityId: '95565085' });
	});

	it('does not match a same-named place in a different country', () => {
		const entity = extractExactEntityMatch(autoCompleteBarcelona, 'BLA');
		expect(entity).toEqual({ skyId: 'BLA', entityId: '128667316' });
	});

	it('is case-insensitive on the sought code', () => {
		expect(extractExactEntityMatch(autoCompleteBarcelona, 'bcn')).toEqual({
			skyId: 'BCN',
			entityId: '95565085'
		});
	});

	it('returns undefined when nothing matches', () => {
		expect(extractExactEntityMatch(autoCompleteBarcelona, 'XXX')).toBeUndefined();
	});

	it('returns undefined for a response with no data array', () => {
		expect(extractExactEntityMatch({ status: false }, 'BCN')).toBeUndefined();
	});
});
