/**
 * How many requests **this browser profile** has spent this month. Issue #146 demoted it
 * to exactly that: a pre-flight estimate, and a lower bound on the truth.
 *
 * The allowance belongs to the RapidAPI key, not to a browser, so this number cannot see
 * a second device, a private window, a cleared profile or another agent's fresh Chromium
 * spending from the same key. `reported-quota.ts` holds the provider's own count, which
 * can; `quota.ts` prefers it wherever the two disagree.
 */
export interface ProviderQuotaRecord {
	monthKey: string;
	used: number;
}

/** Keyed by plain `string`, not the closed `ProviderId` union (../types.ts) — this is
 * parsed straight out of localStorage JSON (`loadProviderQuotaState` below), so it has to
 * tolerate a stored entry for a provider id this build no longer registers (a removed
 * adapter, a renamed one mid-transition) without that parse itself becoming a type error.
 * `quota.ts`'s functions always read and write this with a real `ProviderId`, which indexes
 * a `string`-keyed record just fine. */
export type ProviderQuotaState = Record<string, ProviderQuotaRecord>;

/** Namespaced so this doesn't collide with some other feature's storage key. */
const STORAGE_KEY = 'flights.providerBudget.v1';

/**
 * `localStorage` throws in Safari private mode, in some embedded webviews,
 * and whenever the origin's storage quota is exceeded. Every access in this
 * file goes through a try/catch, and callers get "no usage recorded yet"
 * rather than an exception — a request budget that itself crashes the app is
 * worse than one that occasionally forgets what it counted.
 */
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

function isValidRecord(value: unknown): value is ProviderQuotaRecord {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as Record<string, unknown>).monthKey === 'string' &&
		typeof (value as Record<string, unknown>).used === 'number' &&
		Number.isFinite((value as Record<string, unknown>).used as number)
	);
}

/** Reads every provider's recorded usage. Never throws — corrupt or missing data reads as "nothing used yet". */
export function loadProviderQuotaState(): ProviderQuotaState {
	const raw = readRaw();
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		const state: ProviderQuotaState = {};
		for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (isValidRecord(value)) state[providerId] = { monthKey: value.monthKey, used: value.used };
		}
		return state;
	} catch {
		return {};
	}
}

/** Writes every provider's usage back. Returns whether the write actually landed. */
export function saveProviderQuotaState(state: ProviderQuotaState): boolean {
	try {
		return writeRaw(JSON.stringify(state));
	} catch {
		return false;
	}
}

/** Test-only: production code has no reason to wipe recorded usage — that would let a search exceed a cap it already hit this month. */
export function clearProviderQuotaStateForTests(): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to roll back to and nothing the caller can do about it either.
	}
}
