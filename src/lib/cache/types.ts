/**
 * One cached response, plus the bookkeeping the store needs to answer "is this
 * still good enough to show" and "what should go first when we run out of room".
 */
export interface StoredCacheEntry<T = unknown> {
	/** Namespaced key: `${providerId}:${hash of the query}`. See `defineCacheKey`. */
	key: string;
	/** Denormalised from `key` so a store can drop one provider's entries without parsing keys. */
	providerId: string;
	value: T;
	/** `Date.now()` when this value was fetched. */
	storedAt: number;
	/** How long this value counts as good enough to paint instantly. Set per entry, not globally. */
	ttlMs: number;
	/** `Date.now()` of the last read or write. Eviction removes the smallest of these first. */
	lastAccessedAt: number;
	/** Approximate serialised size in UTF-16 code units, used against the size cap. */
	sizeBytes: number;
}

/**
 * A place to keep cache entries. `staleWhileRevalidate` is written against this
 * interface, not against IndexedDB or `Map` directly, so it behaves identically
 * whichever backend is actually available.
 */
export interface CacheStore {
	/** Reading counts as using it: implementations refresh `lastAccessedAt` here too. */
	get(key: string): Promise<StoredCacheEntry | undefined>;
	/** Stores the entry and evicts least-recently-used entries until back under the size cap. */
	set(entry: StoredCacheEntry): Promise<void>;
	/** Drops every entry for one provider, so a broken provider's cache can be cleared alone. */
	deleteByProvider(providerId: string): Promise<void>;
	/** Drops everything. */
	clear(): Promise<void>;
}
