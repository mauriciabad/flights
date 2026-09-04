import type { ProviderId } from './types';

/**
 * "You are not subscribed to this API" (docs/PROVIDERS.md) means the RapidAPI
 * account has no plan for this provider at all. No amount of retrying fixes
 * that, only subscribing on RapidAPI does — so once it happens once, every
 * later call this session is refused locally instead of burning a real
 * request (and a slot in the console) on a response that cannot change.
 *
 * In-memory and per-session on purpose, not persisted: a user who subscribes
 * mid-session and reloads the page gets a clean slate for free, with no
 * "forget this" button to build or explain.
 */
const permanentlyUnsubscribed = new Set<ProviderId>();

export function markNotSubscribed(providerId: ProviderId): void {
	permanentlyUnsubscribed.add(providerId);
}

export function isPermanentlyUnsubscribed(providerId: ProviderId): boolean {
	return permanentlyUnsubscribed.has(providerId);
}

/** Test-only: production code has no legitimate reason to un-mark a provider mid-session. */
export function resetPermanentFailuresForTests(): void {
	permanentlyUnsubscribed.clear();
}
