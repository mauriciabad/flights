import type { ProviderId } from './types';

/**
 * Defaults sit below the measured free-tier limit (docs/PROVIDERS.md), not at
 * it, so a search that misjudges how many candidates are worth a call still
 * leaves a reserve for whatever comes later in the month. One policy per
 * provider on purpose — docs/PROVIDERS.md is explicit that flight lookups
 * must be hoarded while Agoda's much larger allowance is "worth exploiting,"
 * so a single shared cap across every metered provider would either starve
 * Agoda or, worse, undersell how little Sky Scrapper actually has.
 *
 *   Sky Scrapper  measured limit:  20 requests / month  -> default cap  15 (25% held back)
 *   Flights Sky   measured limit:  50 requests / month  -> default cap  40 (20% held back)
 *   Kiwi.com      measured limit: 300 requests / month  -> default cap 240 (20% held back)
 *   Agoda         measured limit: 500 requests / month  -> default cap 400 (20% held back)
 *   Booking.com   measured limit:  50 requests / month  -> default cap  40 (20% held back)
 *
 * Keyed by each adapter's own `ProviderId` (../types.ts) — `skyscanner`, `flights-sky`,
 * `kiwi`, `agoda`, `booking` — NOT the RapidAPI host slugs docs/PROVIDERS.md records
 * (`sky-scrapper`, `agoda-com`, `booking-com15`). Issue #69: this table used to be keyed by
 * the host slugs on the assumption an adapter's `id` would match, which only happened to
 * hold for `flights-sky`; every other lookup missed silently and fell back to
 * `FALLBACK_PROVIDER_CAP`. `Partial` because a keyless adapter (Ryanair, Transitous, OSRM,
 * the geocode and cheap-routes wrappers) has no tuned entry here at all and is expected to
 * fall back. Re-verify the numbers against docs/PROVIDERS.md before changing them — they
 * are measured, not guessed.
 */
export const DEFAULT_PROVIDER_CAPS: Readonly<Partial<Record<ProviderId, number>>> = Object.freeze({
	skyscanner: 15,
	'flights-sky': 40,
	kiwi: 240,
	agoda: 400,
	booking: 40
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
