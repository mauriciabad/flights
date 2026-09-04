import { DEFAULT_MAX_SIZE_BYTES } from './constants';
import { createIndexedDbCacheStore } from './indexeddb-store';
import { MemoryCacheStore } from './memory-store';
import type { CacheStore } from './types';

let storePromise: Promise<CacheStore> | undefined;

/**
 * The store `staleWhileRevalidate` uses when a caller does not inject one of
 * its own. Tries IndexedDB first and falls back to memory on any failure —
 * missing global, a synchronous throw from `.open()`, or an async `onerror` —
 * so a private-browsing tab degrades to "cache does not persist across
 * reloads" instead of the app crashing on its first fetch.
 */
export function getDefaultStore(): Promise<CacheStore> {
	if (!storePromise) {
		storePromise = createIndexedDbCacheStore({ maxSizeBytes: DEFAULT_MAX_SIZE_BYTES }).catch(
			() => new MemoryCacheStore({ maxSizeBytes: DEFAULT_MAX_SIZE_BYTES })
		);
	}
	return storePromise;
}

/** Test-only: clears the cached store so the next call reopens one from scratch. */
export function resetDefaultStoreForTests(): void {
	storePromise = undefined;
}
