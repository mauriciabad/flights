// Deliberately does not import fake-indexeddb: this file exercises the real
// "IndexedDB does not exist here" path a plain Node/vitest environment
// already gives us for free, which is exactly the shape of a private
// browsing mode that has no IndexedDB at all.
import { describe, expect, it } from 'vitest';
import { getDefaultStore, resetDefaultStoreForTests } from './default-store';
import { MemoryCacheStore } from './memory-store';

describe('getDefaultStore', () => {
	it('degrades to MemoryCacheStore rather than throwing when IndexedDB is unavailable', async () => {
		expect(typeof indexedDB).toBe('undefined');

		resetDefaultStoreForTests();
		const store = await getDefaultStore();

		expect(store).toBeInstanceOf(MemoryCacheStore);
	});

	it('reuses the same store instance across calls', async () => {
		resetDefaultStoreForTests();
		const first = await getDefaultStore();
		const second = await getDefaultStore();
		expect(first).toBe(second);
	});
});
