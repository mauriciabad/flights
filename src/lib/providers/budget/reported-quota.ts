/**
 * Remembers what a provider last said about its own quota, so the next call — in this tab,
 * in another tab, tomorrow morning — starts from the provider's number instead of from
 * this browser's guess.
 *
 * This is the authoritative half of issue #146. `quota-storage.ts` holds the other half:
 * a per-browser tally that is now demoted to a pre-flight estimate, useful only for
 * stopping a fan-out before it fires and for the case where a provider has never told us
 * anything. Where the two disagree, the provider wins (see `quota.ts`).
 *
 * It is still `localStorage`, which sounds like the same mistake, and is not. What is
 * stored here is not a count this app maintains; it is a fact the provider stated, with
 * the instant it stated it. A different browser holding no copy of that fact learns it on
 * its first real call, which is exactly the property the local counter never had.
 */

import { monthKeyFor } from './month-key';
import { parseRateLimitWindows, pickQuotaWindow } from './rate-limit-headers';
import type { ProviderId } from './types';

/** One provider's last self-reported quota. */
export interface ReportedProviderQuota {
	/** The calendar month the reading was taken in. A reading from last month says nothing
	 * about this one — the plan's allowance reset in between — and is discarded on read,
	 * mirroring how `quota.ts` treats a prior-month local record. */
	monthKey: string;
	/** The plan's total allowance, when the provider sent one. Without it `remaining` is
	 * still a hard stop but cannot be turned into "how many have been spent". */
	limit?: number;
	remaining: number;
	/** Epoch millis this app read the headers. Drives the card's "last heard from them"
	 * line — the number is only as current as the last call that carried it. */
	observedAt: number;
	/** Epoch millis the reported window resets, derived from the provider's own `-reset`
	 * seconds. Past this instant the reading describes an allowance that no longer exists,
	 * so it is dropped rather than kept as a pessimistic guess. */
	resetsAt?: number;
	/** The `x-ratelimit-<scope>-*` scope this came from, and the exact header names it was
	 * parsed out of. Kept because no captured response in this repo has ever carried these
	 * headers (see `rate-limit-headers.ts`), so the first person to see one in the wild
	 * should be able to read back what actually arrived. */
	scope: string;
	headerNames: string[];
}

/** Keyed by plain `string` rather than `ProviderId` for the same reason
 * `ProviderQuotaState` is: this is parsed straight out of `localStorage` JSON and has to
 * tolerate an entry for a provider id this build no longer registers. */
export type ReportedQuotaState = Record<string, ReportedProviderQuota>;

const STORAGE_KEY = 'flights.providerBudget.reported.v1';

/** Same discipline as `quota-storage.ts`: `localStorage` throws in Safari private mode and
 * when the origin's storage is full, and a budget that crashes the app is worse than one
 * that forgets. Every access here is wrapped, and a failure reads as "nothing reported". */
function readRaw(): string | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeRaw(raw: string): boolean {
	try {
		if (typeof localStorage === 'undefined') return false;
		localStorage.setItem(STORAGE_KEY, raw);
		return true;
	} catch {
		return false;
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isValidReading(value: unknown): value is ReportedProviderQuota {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.monthKey !== 'string') return false;
	if (!isFiniteNumber(record.remaining) || record.remaining < 0) return false;
	if (!isFiniteNumber(record.observedAt)) return false;
	if (record.limit !== undefined && (!isFiniteNumber(record.limit) || record.limit < 0)) return false;
	if (record.resetsAt !== undefined && !isFiniteNumber(record.resetsAt)) return false;
	if (typeof record.scope !== 'string') return false;
	return Array.isArray(record.headerNames) && record.headerNames.every((name) => typeof name === 'string');
}

/** Every provider's last reported quota. Never throws — corrupt or missing data reads as
 * "no provider has told us anything". */
export function loadReportedQuotaState(): ReportedQuotaState {
	const raw = readRaw();
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		const state: ReportedQuotaState = {};
		for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (isValidReading(value)) state[providerId] = value;
		}
		return state;
	} catch {
		return {};
	}
}

export function saveReportedQuotaState(state: ReportedQuotaState): boolean {
	try {
		return writeRaw(JSON.stringify(state));
	} catch {
		return false;
	}
}

export interface RecordRateLimitOptions {
	/** Overrides `Date.now`. Mainly for tests, so an expiring window can be simulated
	 * without waiting a month for one. */
	now?: () => number;
}

/**
 * Reads a response's rate-limit headers and stores what they said, replacing whatever was
 * stored before.
 *
 * Call it on every response from a metered host, including the failures — a 429 or a 403
 * carries the same headers, and those are the responses where knowing the real remaining
 * count matters most.
 *
 * Returns the reading it stored, or `undefined` when the response carried no quota window
 * this parser could identify. `undefined` means "we learned nothing", and callers must
 * treat it as exactly that: whatever was stored before stays stored, untouched.
 *
 * Always the newest answer wins, never the smallest. A later response reporting *more*
 * remaining is not a mistake to be clamped away — a plan can be upgraded, a daily window
 * can roll over — and preferring our own arithmetic over the provider's latest statement
 * is the whole habit issue #146 is about breaking.
 */
export function recordRateLimitHeaders(
	providerId: ProviderId,
	headers: Headers,
	options: RecordRateLimitOptions = {}
): ReportedProviderQuota | undefined {
	const window = pickQuotaWindow(parseRateLimitWindows(headers));
	if (window === undefined) return undefined;

	const observedAt = (options.now ?? Date.now)();
	const reading: ReportedProviderQuota = {
		monthKey: monthKeyFor(observedAt),
		limit: window.limit,
		remaining: window.remaining,
		observedAt,
		resetsAt: window.resetSeconds === undefined ? undefined : observedAt + window.resetSeconds * 1000,
		scope: window.scope,
		headerNames: window.headerNames
	};

	const state = loadReportedQuotaState();
	state[providerId] = reading;
	saveReportedQuotaState(state);
	return reading;
}

/**
 * The stored reading for one provider, when it still describes the allowance in force now.
 *
 * Two ways a reading stops applying, and both mean "we know nothing again" rather than
 * "the tally is zero":
 *
 * - It was taken in an earlier month. The plan's allowance reset with the calendar, the
 *   same assumption `quota.ts` already makes about its own records.
 * - The window it described has since reset, per the provider's own `-reset` seconds. This
 *   is the more precise of the two and takes precedence where it exists, since a plan need
 *   not renew on the 1st.
 */
export function getReportedProviderQuota(
	providerId: ProviderId,
	options: RecordRateLimitOptions = {}
): ReportedProviderQuota | undefined {
	const nowMs = (options.now ?? Date.now)();
	const reading = loadReportedQuotaState()[providerId];
	if (reading === undefined) return undefined;
	if (reading.monthKey !== monthKeyFor(nowMs)) return undefined;
	if (reading.resetsAt !== undefined && reading.resetsAt <= nowMs) return undefined;
	return reading;
}

/** Test-only, matching `clearProviderQuotaStateForTests`: production code has no reason to
 * forget what a provider told it about its own quota. */
export function clearReportedQuotaForTests(): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to roll back to and nothing the caller can do about it either.
	}
}
