/**
 * Issue #293: the one announcement that says a background revalidation has landed, so
 * whatever is on screen is now older than what the cache holds.
 *
 * Five adapter paths serve a cached answer past its TTL and refetch behind it
 * (`providers/flights/ryanair.ts`, two in `flights/kiwi-public.ts`, `stays/hostelworld.ts`,
 * `transfers/transitous.ts`). Every one of them ended at the cache write. The page had
 * already rendered from the value that write replaced, so the fresher price and its fresher
 * fetch time sat in IndexedDB with nothing to carry them onto a card.
 *
 * Measured with `tools/probe-card-age.mjs` against a real build: age every entry past its own
 * TTL and reload. 76 provider responses land inside 3 seconds, every Kiwi, Ryanair and
 * Hostelworld entry comes back 0 minutes old, and the cards go on saying "fetched 3 hours
 * ago" for as long as you watch them.
 *
 * ## Why an adapter announces this and the cache store does not
 *
 * The tempting version is to fire on every `CacheStore.set`, which would need no adapter to
 * cooperate. It cannot work here. The price ledger (`flexible-dates/record-results.ts`)
 * writes to this same store while the results page renders, so "any write" is a signal the
 * page's own reaction re-triggers, and the search that reacts to it writes the ledger again.
 * The store cannot tell a revalidation from bookkeeping; the adapter that just replaced an
 * answer somebody is looking at knows exactly what it did.
 *
 * A listener is called from a background task nobody awaits. It must schedule work, not do
 * it, and it must not throw.
 */

import type { ProviderId } from '../providers/types';

export type RevalidationListener = (providerId: ProviderId) => void;

const listeners = new Set<RevalidationListener>();

/**
 * Announces that `providerId` has replaced a cached answer with a fresher one. Called after
 * the write, never before: a listener that re-reads the cache has to find the new value
 * there.
 */
export function revalidationSettled(providerId: ProviderId): void {
	// A copy, so a listener that unsubscribes itself while this runs cannot skip the next
	// one along.
	for (const listener of [...listeners]) listener(providerId);
}

/** Subscribes until the returned function is called. */
export function onRevalidationSettled(listener: RevalidationListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
