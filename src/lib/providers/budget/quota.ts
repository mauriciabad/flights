import { getProviderCap } from './caps';
import { monthKeyFor } from './month-key';
import { loadProviderQuotaState, saveProviderQuotaState } from './quota-storage';
import type { ProviderQuotaRecord } from './quota-storage';
import type { ProviderId } from './types';

export interface ProviderQuotaSnapshot {
	providerId: ProviderId;
	monthKey: string;
	used: number;
	cap: number;
	remaining: number;
}

export interface QuotaLookupOptions {
	/** Overrides the stored/default cap. Mainly for tests. */
	cap?: number;
	/** Overrides `Date.now`. Mainly for tests, so a month boundary can be simulated without waiting for one. */
	now?: () => number;
}

export interface ReserveResult {
	ok: boolean;
	/** Usage after this reservation when `ok`, or the unchanged current usage when refused. */
	used: number;
	cap: number;
	monthKey: string;
}

// A record from a prior month is stale usage, not debt carried forward — the
// provider's own quota reset the moment the calendar month did, so reading
// it as anything but zero would refuse calls the real API would happily
// accept.
function usageFromRecord(record: ProviderQuotaRecord | undefined, monthKey: string): number {
	return record && record.monthKey === monthKey ? record.used : 0;
}

/**
 * Atomically checks and reserves `cost` requests against a provider's
 * monthly budget. This runs synchronously and JavaScript is single-threaded,
 * so there is no window between the check and the increment for a second
 * concurrent caller to slip through — that is what makes this a hard stop
 * rather than a check that races the very request it exists to prevent.
 *
 * Reserves before the caller has fired anything: a refusal here means zero
 * network requests were made, by construction, since the caller is expected
 * to check `ok` before calling `fetch` at all.
 */
export function reserveProviderRequests(
	providerId: ProviderId,
	cost: number,
	options: QuotaLookupOptions = {}
): ReserveResult {
	const now = options.now ?? Date.now;
	const cap = options.cap ?? getProviderCap(providerId);
	const monthKey = monthKeyFor(now());
	const state = loadProviderQuotaState();
	const used = usageFromRecord(state[providerId], monthKey);

	if (used + cost > cap) {
		return { ok: false, used, cap, monthKey };
	}

	const nextUsed = used + cost;
	state[providerId] = { monthKey, used: nextUsed };
	saveProviderQuotaState(state);
	return { ok: true, used: nextUsed, cap, monthKey };
}

/** Read-only view of a provider's usage this month, for a settings screen or a search summary. Never mutates anything. */
export function getProviderQuotaSnapshot(
	providerId: ProviderId,
	options: QuotaLookupOptions = {}
): ProviderQuotaSnapshot {
	const now = options.now ?? Date.now;
	const cap = options.cap ?? getProviderCap(providerId);
	const monthKey = monthKeyFor(now());
	const used = usageFromRecord(loadProviderQuotaState()[providerId], monthKey);
	return { providerId, monthKey, used, cap, remaining: Math.max(0, cap - used) };
}
