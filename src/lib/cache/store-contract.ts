// Not itself a `*.test.ts` file, so vitest never collects it directly. It is a
// suite factory: both backends implement the same `CacheStore` interface and
// must behave identically, so the assertions live once here and each backend's
// test file just supplies a way to construct one.
import { describe, expect, it } from 'vitest';
import type { CacheStore, StoredCacheEntry } from './types';

function makeEntry(overrides: Partial<StoredCacheEntry> = {}): StoredCacheEntry {
	const now = Date.now();
	return {
		key: 'provider-a:hash1',
		providerId: 'provider-a',
		value: { hello: 'world' },
		storedAt: now,
		ttlMs: 60_000,
		lastAccessedAt: now,
		sizeBytes: 10,
		...overrides
	};
}

// A real timestamp gap between operations, small enough not to slow the suite
// down but large enough that `Date.now()` reliably moves forward between
// calls — needed so recency-based eviction has an unambiguous order to check
// against, on both the Map-order-based memory store and the index-sorted
// IndexedDB one.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function defineCacheStoreContractTests(
	backendName: string,
	createStore: (options?: { maxSizeBytes?: number }) => Promise<CacheStore> | CacheStore
) {
	describe(`${backendName} — CacheStore contract`, () => {
		it('returns undefined for a key that was never set', async () => {
			const store = await createStore();
			await expect(store.get('missing')).resolves.toBeUndefined();
		});

		it('round-trips a stored entry', async () => {
			const store = await createStore();
			const entry = makeEntry();
			await store.set(entry);
			const found = await store.get(entry.key);
			expect(found?.value).toEqual(entry.value);
			expect(found?.providerId).toBe(entry.providerId);
			expect(found?.ttlMs).toBe(entry.ttlMs);
		});

		it('overwrites a value stored under the same key', async () => {
			const store = await createStore();
			await store.set(makeEntry({ value: { version: 1 } }));
			await store.set(makeEntry({ value: { version: 2 } }));
			const found = await store.get('provider-a:hash1');
			expect(found?.value).toEqual({ version: 2 });
		});

		it("deleteByProvider only removes that provider's entries", async () => {
			const store = await createStore();
			await store.set(makeEntry({ key: 'a:1', providerId: 'a' }));
			await store.set(makeEntry({ key: 'b:1', providerId: 'b' }));

			await store.deleteByProvider('a');

			await expect(store.get('a:1')).resolves.toBeUndefined();
			await expect(store.get('b:1')).resolves.toBeDefined();
		});

		it('clear() drops every provider', async () => {
			const store = await createStore();
			await store.set(makeEntry({ key: 'a:1', providerId: 'a' }));
			await store.set(makeEntry({ key: 'b:1', providerId: 'b' }));

			await store.clear();

			await expect(store.get('a:1')).resolves.toBeUndefined();
			await expect(store.get('b:1')).resolves.toBeUndefined();
		});

		it('refuses to store a value that looks like it carries an API key', async () => {
			const store = await createStore();
			await expect(
				store.set(makeEntry({ value: { apiKey: 'super-secret' } }))
			).rejects.toThrow();
		});

		it('evicts the least recently used entry once over the size cap, not just the oldest inserted one', async () => {
			// Cap fits exactly two 10-byte entries. Inserting a third forces one out.
			const store = await createStore({ maxSizeBytes: 20 });

			await store.set(makeEntry({ key: 'a', providerId: 'p', sizeBytes: 10 }));
			await sleep(5);
			await store.set(makeEntry({ key: 'b', providerId: 'p', sizeBytes: 10 }));
			await sleep(5);

			// Touch "a" so it is now the more recently used of the two — a plain
			// insertion-order (FIFO) eviction would still drop "a" next; true LRU
			// must drop "b" instead.
			await store.get('a');
			await sleep(5);

			await store.set(makeEntry({ key: 'c', providerId: 'p', sizeBytes: 10 }));

			await expect(store.get('b')).resolves.toBeUndefined();
			await expect(store.get('a')).resolves.toBeDefined();
			await expect(store.get('c')).resolves.toBeDefined();
		});

		it('never evicts the only entry, even if it alone is over the cap', async () => {
			const store = await createStore({ maxSizeBytes: 5 });
			await store.set(makeEntry({ key: 'only', providerId: 'p', sizeBytes: 100 }));
			await expect(store.get('only')).resolves.toBeDefined();
		});
	});
}
