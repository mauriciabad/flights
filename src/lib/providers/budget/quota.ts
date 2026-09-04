import { getProviderCap } from './caps';
import { monthKeyFor } from './month-key';
import { loadProviderQuotaState, saveProviderQuotaState } from './quota-storage';
import type { ProviderQuotaRecord } from './quota-storage';
import { getReportedProviderQuota } from './reported-quota';
import type { ReportedProviderQuota } from './reported-quota';
import type { ProviderId } from './types';

export interface ProviderQuotaSnapshot {
	providerId: ProviderId;
	monthKey: string;
	/** The usage this module will act on: the provider's own figure where one applies,
	 * this browser's tally otherwise. See `effectiveUsage` below. */
	used: number;
	/** What this browser alone has counted. Split out from `used` so a settings card can
	 * say which of the two numbers it is showing — an estimate of one profile's spending,
	 * or the account's real position. Issue #146: showing only the first, with no way to
	 * tell them apart, is how "0 of 40 requests spent" sat on screen beside a Booking.com
	 * month that was 85% gone. */
	locallyCounted: number;
	cap: number;
	remaining: number;
	/** The provider's last word on its own quota, when it still applies this month.
	 * `undefined` means no response carrying rate-limit headers has been seen — the normal
	 * state until one is (`rate-limit-headers.ts`), not a sign anything is wrong. */
	reported?: ReportedProviderQuota;
}

export interface QuotaLookupOptions {
	/** Overrides the stored/default cap. Mainly for tests. */
	cap?: number;
	/** Overrides `Date.now`. Mainly for tests, so a month boundary can be simulated without waiting for one. */
	now?: () => number;
}

/** Which limit refused a reservation, so a caller's message can name the real one instead
 * of always blaming this app's own cap. */
export type ReserveRefusal =
	/** This app's own safety cap, held below the provider's real free tier. */
	| 'local-cap'
	/** The provider itself said it does not have this many requests left. */
	| 'provider-reported-empty';

export interface ReserveResult {
	ok: boolean;
	/** Usage after this reservation when `ok`, or the unchanged current usage when refused. */
	used: number;
	cap: number;
	monthKey: string;
	/** Absent when `ok`. */
	refusal?: ReserveRefusal;
	/** The provider's own last answer, when one applies — carried on the result so a
	 * refusal message can quote the number that caused it rather than paraphrasing. */
	reported?: ReportedProviderQuota;
}

// A record from a prior month is stale usage, not debt carried forward — the
// provider's own quota reset the moment the calendar month did, so reading
// it as anything but zero would refuse calls the real API would happily
// accept.
function usageFromRecord(record: ProviderQuotaRecord | undefined, monthKey: string): number {
	return record && record.monthKey === monthKey ? record.used : 0;
}

/**
 * Reconciles the two counts, and the rule is simple: the provider wins.
 *
 * The local tally is a lower bound and always has been. It counts what one browser profile
 * spent, and the allowance belongs to the RapidAPI key, so every other device, private
 * window and cleared profile that spent from the same key is invisible to it. The
 * provider's `limit - remaining` counts all of them. Taking the larger of the two means a
 * browser that has never called anything still stops at the right place, one call after it
 * first hears the truth, instead of confidently spending a month that is already gone.
 *
 * A reading with no `limit` cannot be turned into a usage figure at all — `remaining`
 * alone says how much is left, not how much is spent. That case is not lost: it becomes a
 * hard stop of its own in `reserveProviderRequests`, which refuses outright when the
 * provider says fewer than `cost` requests remain.
 */
function effectiveUsage(locallyCounted: number, reported: ReportedProviderQuota | undefined): number {
	if (reported?.limit === undefined) return locallyCounted;
	return Math.max(locallyCounted, reported.limit - reported.remaining);
}

/** What this app will still spend: whatever its own cap leaves, never more than the
 * provider says exists. */
function remainingFrom(cap: number, used: number, reported: ReportedProviderQuota | undefined): number {
	const underCap = cap - used;
	return Math.max(0, reported === undefined ? underCap : Math.min(underCap, reported.remaining));
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
 *
 * The stored record keeps counting this browser's own requests, unchanged by whatever the
 * provider reports. Folding the provider's figure into it would leave a permanently
 * inflated local number behind the moment that reading expires, which is the same class of
 * mistake as trusting the local number in the first place: a value we computed standing in
 * for one we were handed.
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
	const locallyCounted = usageFromRecord(state[providerId], monthKey);
	const reported = getReportedProviderQuota(providerId, { now });
	const used = effectiveUsage(locallyCounted, reported);

	// Checked before the cap, because it is the stronger claim: this app's cap is a policy
	// we chose and could raise, while "8 requests left on this key" is a fact about the
	// account that no local setting can argue with.
	if (reported !== undefined && reported.remaining < cost) {
		return { ok: false, used, cap, monthKey, refusal: 'provider-reported-empty', reported };
	}

	if (used + cost > cap) {
		return { ok: false, used, cap, monthKey, refusal: 'local-cap', reported };
	}

	state[providerId] = { monthKey, used: locallyCounted + cost };
	saveProviderQuotaState(state);
	return { ok: true, used: used + cost, cap, monthKey, reported };
}

/** Read-only view of a provider's usage this month, for a settings screen or a search summary. Never mutates anything. */
export function getProviderQuotaSnapshot(
	providerId: ProviderId,
	options: QuotaLookupOptions = {}
): ProviderQuotaSnapshot {
	const now = options.now ?? Date.now;
	const cap = options.cap ?? getProviderCap(providerId);
	const monthKey = monthKeyFor(now());
	const locallyCounted = usageFromRecord(loadProviderQuotaState()[providerId], monthKey);
	const reported = getReportedProviderQuota(providerId, { now });
	const used = effectiveUsage(locallyCounted, reported);
	return {
		providerId,
		monthKey,
		used,
		locallyCounted,
		cap,
		remaining: remainingFrom(cap, used, reported),
		reported
	};
}
