import { DEFAULT_MAX_SIZE_BYTES } from './constants';
import { assertNoSecretLeakage } from './guard';
import type { CacheStore, StoredCacheEntry } from './types';

const DB_VERSION = 1;
const ENTRIES_STORE = 'entries';
const PROVIDER_INDEX = 'providerId';
const LAST_ACCESSED_INDEX = 'lastAccessedAt';

export interface IndexedDbCacheStoreOptions {
	dbName?: string;
	maxSizeBytes?: number;
}

/**
 * Opens (and, on first run, creates) the cache database. Rejects rather than
 * throwing synchronously in every failure path, including the case where
 * `indexedDB` does not exist at all, so a caller can `.catch()` this into a
 * fallback instead of crashing. Some private-browsing modes make `.open()`
 * throw synchronously instead of failing async, so that path is caught too.
 */
export async function createIndexedDbCacheStore(
	options: IndexedDbCacheStoreOptions = {}
): Promise<IndexedDbCacheStore> {
	if (typeof indexedDB === 'undefined') {
		throw new Error('IndexedDB is not available in this environment');
	}
	const db = await openDatabase(options.dbName ?? 'flights-cache');
	return new IndexedDbCacheStore(db, options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES);
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.open(dbName, DB_VERSION);
		} catch (error) {
			reject(error);
			return;
		}
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
				const store = db.createObjectStore(ENTRIES_STORE, { keyPath: 'key' });
				store.createIndex(PROVIDER_INDEX, 'providerId', { unique: false });
				store.createIndex(LAST_ACCESSED_INDEX, 'lastAccessedAt', { unique: false });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Failed to open cache database'));
		request.onblocked = () => reject(new Error('Cache database open was blocked'));
	});
}

/**
 * The primary backend. Every method opens exactly one transaction and drives
 * it to completion with chained request callbacks rather than `await`ing
 * unrelated promises in between: mixing those in is the classic way an
 * IndexedDB transaction auto-commits out from under you before your next
 * request is issued.
 */
export class IndexedDbCacheStore implements CacheStore {
	constructor(
		private readonly db: IDBDatabase,
		private readonly maxSizeBytes: number
	) {}

	async get(key: string): Promise<StoredCacheEntry | undefined> {
		return new Promise((resolve, reject) => {
			const tx = this.db.transaction(ENTRIES_STORE, 'readwrite');
			const store = tx.objectStore(ENTRIES_STORE);
			let result: StoredCacheEntry | undefined;

			const request = store.get(key);
			request.onsuccess = () => {
				const entry = request.result as StoredCacheEntry | undefined;
				if (!entry) return;
				// A read counts as a use: touch the recency stamp so this entry
				// survives longer than one nobody has asked for since it was stored.
				result = { ...entry, lastAccessedAt: Date.now() };
				store.put(result);
			};

			tx.onerror = () => reject(tx.error);
			tx.oncomplete = () => resolve(result);
		});
	}

	async set(entry: StoredCacheEntry): Promise<void> {
		// Thrown synchronously here, this method being `async` still turns it
		// into a rejected promise like every other failure path below —
		// callers only ever need to handle one shape of failure.
		assertNoSecretLeakage(entry.value);

		return new Promise((resolve, reject) => {
			const tx = this.db.transaction(ENTRIES_STORE, 'readwrite');
			const store = tx.objectStore(ENTRIES_STORE);
			store.put(entry);
			this.evictLeastRecentlyUsedUntilUnderCap(store);
			tx.onerror = () => reject(tx.error);
			tx.oncomplete = () => resolve();
		});
	}

	async deleteByProvider(providerId: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const tx = this.db.transaction(ENTRIES_STORE, 'readwrite');
			const index = tx.objectStore(ENTRIES_STORE).index(PROVIDER_INDEX);
			const request = index.openCursor(IDBKeyRange.only(providerId));
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return;
				cursor.delete();
				cursor.continue();
			};
			tx.onerror = () => reject(tx.error);
			tx.oncomplete = () => resolve();
		});
	}

	async clear(): Promise<void> {
		return new Promise((resolve, reject) => {
			const tx = this.db.transaction(ENTRIES_STORE, 'readwrite');
			tx.objectStore(ENTRIES_STORE).clear();
			tx.onerror = () => reject(tx.error);
			tx.oncomplete = () => resolve();
		});
	}

	// Walks every entry oldest-accessed-first (the index is already sorted that
	// way) and deletes from the front until the running total is back under
	// the cap. A full scan rather than a maintained running total: it needs no
	// second object store to keep in sync, and this cache holds at most a few
	// hundred entries for a handful of providers, so an occasional O(n) cursor
	// costs nothing a phone would notice.
	private evictLeastRecentlyUsedUntilUnderCap(store: IDBObjectStore): void {
		const request = store.index(LAST_ACCESSED_INDEX).openCursor();
		const seen: StoredCacheEntry[] = [];
		let total = 0;

		request.onsuccess = () => {
			const cursor = request.result;
			if (cursor) {
				const entry = cursor.value as StoredCacheEntry;
				seen.push(entry);
				total += entry.sizeBytes;
				cursor.continue();
				return;
			}

			let excess = total - this.maxSizeBytes;
			let i = 0;
			// Always leave at least one entry, even an oversized one: deleting it
			// would not create room for anything, only turn it into a permanent miss.
			while (excess > 0 && seen.length - i > 1) {
				store.delete(seen[i].key);
				excess -= seen[i].sizeBytes;
				i++;
			}
		};
	}
}
