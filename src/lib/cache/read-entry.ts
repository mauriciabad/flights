import type { CacheKey } from './key';
import type { CacheStore } from './types';

/**
 * One cached value and the two facts a caller needs about it: when it really came off the
 * wire, and whether that is still inside its TTL.
 *
 * This exists because the adapters in `providers/` each retyped the same three lines of
 * cache-aside reading, and the version they retyped was the one issue #155 had just
 * removed:
 *
 * ```ts
 * if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
 * ```
 *
 * Discarding on expiry throws away data the app is already holding and sends the user back
 * to the network for it. `kiwi-public.ts` shipped with that line an hour after `ryanair.ts`
 * lost it (#165), and one adapter doing it is enough to undo stale-first for a whole page,
 * because the page waits on the slowest source.
 *
 * `fresh` is a separate field rather than a boolean beside `value`, so "only if it is
 * current" and "whatever its age" are different property accesses rather than a flag
 * someone can forget to check.
 */
export interface CachedEntry<T> {
	value: T;
	/** Epoch millis the value came off the wire — `ProviderSource.fetchedAt`'s input, so a
	 * card can say how old this answer is instead of claiming it just arrived. */
	storedAt: number;
	/** The same value while it is within its TTL, `undefined` once it is not. */
	fresh: T | undefined;
}

/**
 * Reads `key` and reports its age, never discarding a value for being past its TTL.
 *
 * The three tiers `staleWhileRevalidate` classifies are the model, and this is the half of
 * it that suits a `FlightProvider` method: that generator always calls its fetcher, which
 * is the wrong shape for a method resolving one `ProviderResult` with no consumer able to
 * observe a provisional yield. A caller here serves `value` immediately, stamps its
 * `storedAt` onto the source, and decides for itself whether to refetch behind the answer.
 */
export async function readCachedEntry<T>(
	store: CacheStore,
	key: CacheKey
): Promise<CachedEntry<T> | undefined> {
	const entry = await store.get(key.raw);
	if (entry === undefined) return undefined;
	const value = entry.value as T;
	const isFresh = Date.now() - entry.storedAt < entry.ttlMs;
	return { value, storedAt: entry.storedAt, fresh: isFresh ? value : undefined };
}
