import { getDefaultStore } from './default-store';
import { classifyExpiredFallbackReason } from './expired-fallback-reason';
import { estimateByteSize } from './size';
import type { ExpiredFallbackReason } from './expired-fallback-reason';
import type { CacheKey } from './key';
import type { CacheStore } from './types';

export type { ExpiredFallbackReason } from './expired-fallback-reason';

/** `value` just arrived from the fetcher, or came from an entry still within its TTL
 * with no refetch outcome to report yet. Good enough to show as current, no caveat. */
export interface FreshResult<T> {
	value: T;
	state: 'fresh';
	isRevalidating: false;
}

/** `value` came from the cache, painted before or instead of waiting on the fetcher.
 * Covers both an entry still within its TTL (trustworthy on its own, refetching only
 * to keep it that way) and one already past it (refetching because it has to, not
 * because it wants to). A component reads `isRevalidating` and `revalidationError`
 * the same way either way, since in both cases a background fetch is or was in
 * flight and may still turn `value` into `'fresh'`. */
export interface StaleResult<T> {
	value: T;
	state: 'stale';
	/** True until the in-flight refetch for this key has settled, one way or the other. */
	isRevalidating: boolean;
	/**
	 * Set when a refetch failed while the entry was still within its TTL. `value` is
	 * still the last good value, so this exists so a UI can stop a spinner and say
	 * "couldn't refresh" without blanking what it was already showing. Contrast with
	 * `ExpiredFallbackResult`, reached when the entry was past its TTL when the same
	 * kind of failure happened: at that point the caveat is no longer optional colour,
	 * it is the reason `value` is being shown at all.
	 */
	revalidationError?: unknown;
}

/**
 * `value` is an entry that was already past its TTL, kept only because the refetch
 * that would have replaced it FAILED. This is issue #35's tier: a Sky Scrapper
 * account with its 20-requests-a-month quota spent has nothing else to offer, and a
 * priced-yesterday fare beats a blank screen as long as it says so.
 *
 * A separate interface, not `StaleResult` with optional extra fields, because
 * `ageMs` and `reason` are exactly the two facts a component needs to be honest
 * about this value (AGENTS.md: never present an estimate as a fact), and making
 * them required here means the compiler refuses code that reads `.value` after
 * checking `state === 'expired-fallback'` without also having them in scope. A
 * convention ("remember to show the age") would only catch that at review time,
 * if at all.
 */
export interface ExpiredFallbackResult<T> {
	value: T;
	state: 'expired-fallback';
	isRevalidating: false;
	/** `Date.now() - storedAt` at the moment this was yielded, i.e. how old `value`
	 * actually is, not just "older than its TTL". */
	ageMs: number;
	reason: ExpiredFallbackReason;
}

export type StaleWhileRevalidateResult<T> = FreshResult<T> | StaleResult<T> | ExpiredFallbackResult<T>;

export interface StaleWhileRevalidateOptions {
	/** Overrides the default IndexedDB-or-memory store. Mainly for tests. */
	store?: CacheStore;
}

/**
 * Shows the cached value for `key` at once whenever one exists, within its TTL or
 * not, then always calls `fetcher` and reports what comes back. "Refetch always",
 * not "refetch if stale": staleness only decides how the cached value gets labelled
 * while painted, never whether to bother checking for a fresher one.
 *
 * Yields once on a cold cache: the fresh value, or nothing at all if `fetcher`
 * rejects, since there is genuinely nothing to fall back to and a caller awaiting
 * this generator should see the same rejection calling `fetcher()` directly would
 * give it. Yields twice on a warm one: the cached value first (`'stale'`), then
 * either the fresh value, or, if the refetch failed:
 * - the same cached value again as `'stale'` with `revalidationError` set, if it
 *   was still within its TTL when this call started. It was trustworthy on its
 *   own terms already, so the failed refetch is a footnote.
 * - that value re-tagged `'expired-fallback'`, carrying its age and a classified
 *   `reason`, if it was already past its TTL. This is issue #35: a Sky Scrapper
 *   account with no quota left has nothing better to offer, and yesterday's fare
 *   labelled as such beats a blank screen. `AGENTS.md`'s "never present an
 *   estimate as a fact" is answered by that label, not by withholding the number.
 */
export async function* staleWhileRevalidate<T>(
	key: CacheKey,
	fetcher: () => Promise<T>,
	options: StaleWhileRevalidateOptions = {}
): AsyncGenerator<StaleWhileRevalidateResult<T>, void, unknown> {
	const store = options.store ?? (await getDefaultStore());

	const existing = await store.get(key.raw);
	const isWithinTtl = existing !== undefined && Date.now() - existing.storedAt < existing.ttlMs;

	if (existing !== undefined) {
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
		if (existing !== undefined) {
			// Past its TTL and the refetch that would have replaced it failed: the
			// value is the only data the app has, so it is shown anyway, but as a
			// clearly different, more cautious tier than plain `'stale'`. See
			// ExpiredFallbackResult for why age and reason are required, not optional.
			yield {
				value: existing.value as T,
				state: 'expired-fallback',
				isRevalidating: false,
				ageMs: Date.now() - existing.storedAt,
				reason: classifyExpiredFallbackReason(error)
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
