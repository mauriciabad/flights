import { getDefaultStore } from './default-store';
import { estimateByteSize } from './size';
import type { CacheKey } from './key';
import type { CacheStore } from './types';

export interface StaleWhileRevalidateResult<T> {
	value: T;
	/**
	 * `'stale'`: `value` came from the cache. `'fresh'`: `value` just arrived
	 * from the fetcher. A UI can badge the two differently, e.g. a faded price
	 * with a small spinner while stale, solid once fresh.
	 */
	state: 'stale' | 'fresh';
	/** True until the in-flight refetch for this key has settled, one way or the other. */
	isRevalidating: boolean;
	/**
	 * Set when a refetch failed. `value` is still the last good stale value —
	 * this event exists so a UI can stop a spinner and say "couldn't refresh"
	 * without ever having to blank what it was already showing.
	 */
	revalidationError?: unknown;
}

export interface StaleWhileRevalidateOptions {
	/** Overrides the default IndexedDB-or-memory store. Mainly for tests. */
	store?: CacheStore;
}

/**
 * Shows the cached value for `key` at once if one is still within its TTL,
 * then always calls `fetcher` and reports what comes back — this is "refetch
 * always", not "refetch if stale": staleness only decides whether the cached
 * value is trustworthy enough to paint immediately, never whether to bother
 * checking for a fresh one.
 *
 * Yields once (the fresh value) on a cold cache or an expired entry. Yields
 * twice on a warm one: the stale value first, then either the fresh value or,
 * if the refetch failed, the same stale value again with `revalidationError`
 * set. A cold cache whose fetch fails has nothing to show and rejects, same
 * as calling `fetcher()` directly would.
 *
 * An entry past its TTL is treated as a miss for the instant paint rather
 * than shown anyway: a five-minute-old fare presented as current is a wrong
 * price, not a fast one. That does mean a stale-but-expired entry is not used
 * as a last-resort fallback if the subsequent fetch then fails — an arguable
 * call biased towards not showing a number that turned out to be wrong over
 * always having a number to show.
 */
export async function* staleWhileRevalidate<T>(
	key: CacheKey,
	fetcher: () => Promise<T>,
	options: StaleWhileRevalidateOptions = {}
): AsyncGenerator<StaleWhileRevalidateResult<T>, void, unknown> {
	const store = options.store ?? (await getDefaultStore());

	const existing = await store.get(key.raw);
	const isWithinTtl = existing !== undefined && Date.now() - existing.storedAt < existing.ttlMs;

	if (existing !== undefined && isWithinTtl) {
		yield { value: existing.value as T, state: 'stale', isRevalidating: true };
	}

	try {
		const fresh = await fetcher();
		await store.set({
			key: key.raw,
			providerId: key.providerId,
			value: fresh,
			storedAt: Date.now(),
			ttlMs: key.ttlMs,
			lastAccessedAt: Date.now(),
			sizeBytes: estimateByteSize(fresh)
		});
		yield { value: fresh, state: 'fresh', isRevalidating: false };
	} catch (error) {
		if (existing !== undefined && isWithinTtl) {
			yield {
				value: existing.value as T,
				state: 'stale',
				isRevalidating: false,
				revalidationError: error
			};
			return;
		}
		throw error;
	}
}

/** Clears every cached entry for one provider, without touching any other provider's. */
export async function clearProviderCache(providerId: string, store?: CacheStore): Promise<void> {
	const target = store ?? (await getDefaultStore());
	await target.deleteByProvider(providerId);
}

/** Clears the whole cache, every provider. */
export async function clearAllCaches(store?: CacheStore): Promise<void> {
	const target = store ?? (await getDefaultStore());
	await target.clear();
}
