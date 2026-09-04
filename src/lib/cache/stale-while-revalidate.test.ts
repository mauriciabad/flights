import { describe, expect, it, vi } from 'vitest';
import { defineCacheKey } from './key';
import { MemoryCacheStore } from './memory-store';
import { staleWhileRevalidate } from './stale-while-revalidate';

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const value of generator) results.push(value);
	return results;
}

describe('staleWhileRevalidate', () => {
	it('on a cold cache, yields only the fresh value', async () => {
		const store = new MemoryCacheStore();
		const key = defineCacheKey('skyscanner', { origin: 'BCN' }, 60_000);
		const fetcher = vi.fn().mockResolvedValue({ price: 100 });

		const results = await collect(staleWhileRevalidate(key, fetcher, { store }));

		expect(results).toEqual([{ value: { price: 100 }, state: 'fresh', isRevalidating: false }]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('on a warm cache, yields the stale value first and the fresh value second', async () => {
		const store = new MemoryCacheStore();
		const key = defineCacheKey('skyscanner', { origin: 'BCN' }, 60_000);

		// Warm the cache with a first successful call.
		await collect(staleWhileRevalidate(key, vi.fn().mockResolvedValue({ price: 100 }), { store }));

		const fetcher = vi.fn().mockResolvedValue({ price: 120 });
		const results = await collect(staleWhileRevalidate(key, fetcher, { store }));

		expect(results).toEqual([
			{ value: { price: 100 }, state: 'stale', isRevalidating: true },
			{ value: { price: 120 }, state: 'fresh', isRevalidating: false }
		]);
		// "Refetch always": the second call still hits the network even though a
		// cached value existed and was shown immediately.
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('leaves the stale value in place, unblanked, when a refetch fails', async () => {
		const store = new MemoryCacheStore();
		const key = defineCacheKey('skyscanner', { origin: 'BCN' }, 60_000);

		await collect(staleWhileRevalidate(key, vi.fn().mockResolvedValue({ price: 100 }), { store }));

		const failingFetcher = vi.fn().mockRejectedValue(new Error('provider is down'));
		const results = await collect(staleWhileRevalidate(key, failingFetcher, { store }));

		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({ value: { price: 100 }, state: 'stale', isRevalidating: true });
		expect(results[1].value).toEqual({ price: 100 });
		expect(results[1].state).toBe('stale');
		expect(results[1].isRevalidating).toBe(false);
		expect(results[1].revalidationError).toBeInstanceOf(Error);

		// The failure must not have overwritten what is actually in storage either
		// — a later, unrelated read must still see the last good value.
		const stored = await store.get(key.raw);
		expect(stored?.value).toEqual({ price: 100 });
	});

	it('rejects when the cache is cold and the fetch fails: there is nothing to show', async () => {
		const store = new MemoryCacheStore();
		const key = defineCacheKey('skyscanner', { origin: 'BCN' }, 60_000);
		const failingFetcher = vi.fn().mockRejectedValue(new Error('provider is down'));

		await expect(collect(staleWhileRevalidate(key, failingFetcher, { store }))).rejects.toThrow(
			'provider is down'
		);
	});

	it('treats an entry past its TTL as a miss for the instant paint, not as truth', async () => {
		const store = new MemoryCacheStore();
		const key = defineCacheKey('fares', { origin: 'BCN' }, 10); // 10ms TTL: a fare goes stale fast

		await collect(staleWhileRevalidate(key, vi.fn().mockResolvedValue({ price: 100 }), { store }));
		await new Promise((resolve) => setTimeout(resolve, 30));

		const fetcher = vi.fn().mockResolvedValue({ price: 130 });
		const results = await collect(staleWhileRevalidate(key, fetcher, { store }));

		// No stale emission this time: the cached price is old enough that
		// showing it as current would be a wrong price, not a fast one.
		expect(results).toEqual([{ value: { price: 130 }, state: 'fresh', isRevalidating: false }]);
	});
});
