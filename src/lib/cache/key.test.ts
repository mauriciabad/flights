import { describe, expect, it } from 'vitest';
import { defineCacheKey } from './key';

describe('defineCacheKey', () => {
	it('namespaces the key with the provider id', () => {
		const key = defineCacheKey('skyscanner', { origin: 'BCN' }, 1000);
		expect(key.raw.startsWith('skyscanner:')).toBe(true);
		expect(key.providerId).toBe('skyscanner');
	});

	it('carries the ttl unchanged', () => {
		const key = defineCacheKey('agoda', { city: 'Vienna' }, 42_000);
		expect(key.ttlMs).toBe(42_000);
	});

	it('hashes equivalent queries the same regardless of key order', () => {
		const a = defineCacheKey('skyscanner', { origin: 'BCN', destination: 'VIE' }, 1000);
		const b = defineCacheKey('skyscanner', { destination: 'VIE', origin: 'BCN' }, 1000);
		expect(a.raw).toBe(b.raw);
	});

	it('hashes different queries differently', () => {
		const a = defineCacheKey('skyscanner', { origin: 'BCN' }, 1000);
		const b = defineCacheKey('skyscanner', { origin: 'VIE' }, 1000);
		expect(a.raw).not.toBe(b.raw);
	});

	it('keeps the same query separate per provider, so clearing one never touches the other', () => {
		const a = defineCacheKey('skyscanner', { origin: 'BCN' }, 1000);
		const b = defineCacheKey('agoda', { origin: 'BCN' }, 1000);
		expect(a.raw).not.toBe(b.raw);
		expect(a.providerId).not.toBe(b.providerId);
	});

	it('rejects an empty provider id', () => {
		expect(() => defineCacheKey('', {}, 1000)).toThrow();
	});

	it('rejects a non-positive ttl', () => {
		expect(() => defineCacheKey('skyscanner', {}, 0)).toThrow();
		expect(() => defineCacheKey('skyscanner', {}, -1)).toThrow();
	});
});
