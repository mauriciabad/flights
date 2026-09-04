import type { ProviderId } from './types';

/**
 * Defaults sit below the measured free-tier limit (docs/PROVIDERS.md), not at
 * it, so a search that misjudges how many candidates are worth a call still
 * leaves a reserve for whatever comes later in the month.
 *
 *   Sky Scrapper measured limit: 20 requests / month  -> default cap 15 (25% held back)
 *   Flights Sky measured limit:  50 requests / month  -> default cap 40 (20% held back)
 *
 * Keyed by the same provider id strings the registry will use once issue #2
 * lands. Re-verify against docs/PROVIDERS.md before changing these — they
 * are measured numbers, not guesses.
 */
export const DEFAULT_PROVIDER_CAPS: Readonly<Record<string, number>> = Object.freeze({
	'sky-scrapper': 15,
	'flights-sky': 40
});

/** Applied to a metered provider with no entry above. Conservative on purpose: an unlisted metered provider still gets a hard stop rather than none. */
export const FALLBACK_PROVIDER_CAP = 10;

const STORAGE_KEY = 'flights.providerBudget.caps.v1';

function readOverrides(): Record<string, number> {
	try {
		if (typeof localStorage === 'undefined') return {};
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		const overrides: Record<string, number> = {};
		for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
				overrides[providerId] = value;
			}
		}
		return overrides;
	} catch {
		return {};
	}
}

function writeOverrides(overrides: Record<string, number>): boolean {
	try {
		if (typeof localStorage === 'undefined') return false;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
		return true;
	} catch {
		return false;
	}
}

/** The cap actually in effect for a provider: a stored user override if one exists, else the safe default. */
export function getProviderCap(providerId: ProviderId): number {
	const overrides = readOverrides();
	return overrides[providerId] ?? DEFAULT_PROVIDER_CAPS[providerId] ?? FALLBACK_PROVIDER_CAP;
}

/**
 * Lets a settings screen raise or lower a provider's cap. Nothing here
 * bounds the value against the real RapidAPI limit — a user who has read
 * their own dashboard is allowed to know their plan better than a hardcoded
 * table does.
 */
export function setProviderCapOverride(providerId: ProviderId, cap: number): boolean {
	const overrides = readOverrides();
	overrides[providerId] = cap;
	return writeOverrides(overrides);
}

/** Drops back to the default cap for one provider. */
export function clearProviderCapOverride(providerId: ProviderId): boolean {
	const overrides = readOverrides();
	delete overrides[providerId];
	return writeOverrides(overrides);
}
