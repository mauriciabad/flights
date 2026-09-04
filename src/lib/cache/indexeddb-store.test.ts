import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createIndexedDbCacheStore } from './indexeddb-store';
import { defineCacheStoreContractTests } from './store-contract';

let dbCounter = 0;

defineCacheStoreContractTests('IndexedDbCacheStore', (options) =>
	createIndexedDbCacheStore({
		dbName: `flights-cache-test-${dbCounter++}`,
		maxSizeBytes: options?.maxSizeBytes
	})
);

describe('createIndexedDbCacheStore', () => {
	it('rejects when indexedDB is not available, instead of throwing synchronously', async () => {
		const original = globalThis.indexedDB;
		// @ts-expect-error - simulating a private-browsing mode where indexedDB does not exist
		delete globalThis.indexedDB;
		try {
			await expect(createIndexedDbCacheStore({ dbName: 'unavailable' })).rejects.toThrow();
		} finally {
			globalThis.indexedDB = original;
		}
	});
});
