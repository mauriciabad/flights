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
		const second = results[1];
		expect(second.value).toEqual({ price: 100 });
		expect(second.state).toBe('stale');
		expect(second.isRevalidating).toBe(false);
		// Narrowed only so `revalidationError` type-checks: `state` is now a
		// discriminated union (issue #35 added `'expired-fallback'`, which has no
		// such field), so reading it needs the same narrowing a real caller would
		// have to do, even though the runtime assertion above already proved it.
		if (second.state !== 'stale') throw new Error('unreachable');
		expect(second.revalidationError).toBeInstanceOf(Error);

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

	// Changed by issue #35: an entry past its TTL used to be treated as a plain
	// miss here, painting nothing until the fetch settled. It is now painted
	// immediately too, same as a within-TTL entry, because the whole point of
	// #35 is that a past-TTL value is the best the app has until a fresh one
	// actually arrives (or the refetch fails, see 'yields an expired entry as a
	// fallback...' below). The refetch itself is unaffected: it still runs and
	// still wins on success, so a five-minute-old fare is still never the last
	// word if the network says otherwise.
	it('paints an entry past its TTL immediately too, then replaces it once the refetch succeeds', async () => {
		const store = new MemoryCacheStore();
		const key = defineCacheKey('fares', { origin: 'BCN' }, 10); // 10ms TTL: a fare goes stale fast

		await collect(staleWhileRevalidate(key, vi.fn().mockResolvedValue({ price: 100 }), { store }));
		await new Promise((resolve) => setTimeout(resolve, 30));

		const fetcher = vi.fn().mockResolvedValue({ price: 130 });
		const results = await collect(staleWhileRevalidate(key, fetcher, { store }));

		expect(results).toEqual([
			{ value: { price: 100 }, state: 'stale', isRevalidating: true },
			{ value: { price: 130 }, state: 'fresh', isRevalidating: false }
		]);
	});

	it('yields an expired entry as an expired-fallback, with its age and the failure reason, when the refetch fails', async () => {
		const store = new MemoryCacheStore();
		const key = defineCacheKey('skyscanner', { origin: 'BCN' }, 10); // 10ms TTL

		await collect(staleWhileRevalidate(key, vi.fn().mockResolvedValue({ price: 100 }), { store }));
		await new Promise((resolve) => setTimeout(resolve, 30));

		const quotaError = { code: 'quota-exceeded', message: 'Monthly quota used up.', status: 429 };
		const failingFetcher = vi.fn().mockRejectedValue(quotaError);
		const results = await collect(staleWhileRevalidate(key, failingFetcher, { store }));

		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({ value: { price: 100 }, state: 'stale', isRevalidating: true });

		const fallback = results[1];
		expect(fallback.state).toBe('expired-fallback');
		expect(fallback.value).toEqual({ price: 100 });
		expect(fallback.isRevalidating).toBe(false);
		if (fallback.state !== 'expired-fallback') throw new Error('unreachable');
		// >= 10 (the TTL) rather than an exact number: real time passed between
		// storing the entry and reading it back, this only pins down the floor.
		expect(fallback.ageMs).toBeGreaterThanOrEqual(10);
		expect(fallback.reason).toEqual({ code: 'quota-exceeded', message: 'Monthly quota used up.' });

		// A failed refetch must not touch what is actually in storage: the next
		// unrelated read should still see the same expired-but-real entry, not
		// something rewritten by the failed attempt.
		const stored = await store.get(key.raw);
		expect(stored?.value).toEqual({ price: 100 });
	});

	it('still rejects on a cold cache even for a classifiable error, since there is nothing to fall back to', async () => {
		const store = new MemoryCacheStore();
		const key = defineCacheKey('skyscanner', { origin: 'BCN' }, 60_000);
		const quotaError = { code: 'quota-exceeded', message: 'Monthly quota used up.', status: 429 };
		const failingFetcher = vi.fn().mockRejectedValue(quotaError);

		// A quota-shaped rejection is exactly the kind of error the
		// expired-fallback tier classifies, but a cold cache has no old value to
		// tag with it, so it must still reject rather than invent one.
		await expect(collect(staleWhileRevalidate(key, failingFetcher, { store }))).rejects.toBe(
			quotaError
		);
	});
});
