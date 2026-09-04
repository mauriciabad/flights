import { cloneValue } from './clone';
import { DEFAULT_MAX_SIZE_BYTES } from './constants';
import { assertNoSecretLeakage } from './guard';
import type { CacheStore, StoredCacheEntry } from './types';

export interface MemoryCacheStoreOptions {
	maxSizeBytes?: number;
}

/**
 * The fallback backend, used when IndexedDB is unavailable (some private
 * browsing modes) or fails to open. Also handy in tests, since it needs no
 * environment setup.
 *
 * Recency is tracked for free by relying on `Map`'s iteration order: deleting
 * and re-inserting a key moves it to the end, so the least-recently-used entry
 * is always whichever key iteration reaches first.
 */
export class MemoryCacheStore implements CacheStore {
	private readonly entries = new Map<string, StoredCacheEntry>();
	private readonly maxSizeBytes: number;
	private totalSizeBytes = 0;

	constructor(options: MemoryCacheStoreOptions = {}) {
		this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
	}

	async get(key: string): Promise<StoredCacheEntry | undefined> {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		const touched: StoredCacheEntry = { ...entry, lastAccessedAt: Date.now() };
		this.entries.delete(key);
		this.entries.set(key, touched);
		return { ...touched, value: cloneValue(touched.value) };
	}

	async set(entry: StoredCacheEntry): Promise<void> {
		assertNoSecretLeakage(entry.value);

		const stored: StoredCacheEntry = { ...entry, value: cloneValue(entry.value) };
		const previous = this.entries.get(entry.key);
		if (previous) {
			this.totalSizeBytes -= previous.sizeBytes;
			this.entries.delete(entry.key);
		}
		this.entries.set(entry.key, stored);
		this.totalSizeBytes += entry.sizeBytes;

		this.evictLeastRecentlyUsedUntilUnderCap();
	}

	async deleteByProvider(providerId: string): Promise<void> {
		for (const [key, entry] of this.entries) {
			if (entry.providerId === providerId) {
				this.totalSizeBytes -= entry.sizeBytes;
				this.entries.delete(key);
			}
		}
	}

	async clear(): Promise<void> {
		this.entries.clear();
		this.totalSizeBytes = 0;
	}

	private evictLeastRecentlyUsedUntilUnderCap(): void {
		// Always leave the most recent entry in place, even if it alone exceeds
		// the cap: refusing to cache it entirely would not free any more room,
		// and would turn one oversized response into a permanent cache miss.
		while (this.totalSizeBytes > this.maxSizeBytes && this.entries.size > 1) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey === undefined) break;
			const oldest = this.entries.get(oldestKey);
			this.entries.delete(oldestKey);
			if (oldest) this.totalSizeBytes -= oldest.sizeBytes;
		}
	}
}
