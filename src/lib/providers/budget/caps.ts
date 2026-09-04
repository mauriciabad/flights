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

/**
 * Issue #94's fix for the pipeline's old binary free/metered split, which could not tell
 * Sky Scrapper's 20-a-month cap from Agoda's 500 apart and, applied uniformly to stay
 * providers, made a priced bed structurally unreachable no matter what key a traveller
 * configured. A provider whose own cap can absorb at least this many searches like the one
 * being priced needs no extra opt-in beyond the key itself — pasting a key already says
 * "use this provider." Below it, one careless search could burn a meaningful slice of the
 * whole month (Sky Scrapper's cap sustains exactly 15 one-request searches), so it keeps
 * requiring the traveller to see the cost and agree first (`pipeline.ts`'s "confirm" tier).
 *
 * 20 sits just above Sky Scrapper's own worst case (15 ÷ 1 = 15) and at or below both real
 * stay adapters' (Booking: 40 ÷ 2 = 20 exactly; Agoda: 400 ÷ 6 ≈ 67) — re-verify this still
 * separates them correctly before changing either the caps above or this number.
 */
export const MIN_SEARCHES_PER_MONTH_FOR_AUTO_RUN = 20;

/**
 * Whether a provider is cheap enough, relative to ITS OWN tracked cap (`getProviderCap`,
 * including any user override), to run the moment a key is configured, with no further
 * opt-in beyond that key. Reads the live cap rather than naming providers here, so an
 * adapter added later is classified by its real numbers the day it registers, never
 * silently defaulted to "always ask" or "never ask" by omission.
 *
 * `costPerSearch` is the cost of ONE WHOLE SEARCH, not of one provider call. Issue #148:
 * this distinction was the entire bug. The parameter used to be a single `searchStays`
 * estimate, and the ratio below was then read as "searches this key affords per month" —
 * but `pipeline.ts` runs a stay lookup for EVERY connection candidate, six of them
 * ordinarily and twenty-four on the fallback sweep. Booking passed at exactly
 * `40 / 2 = 20`, while its real capacity under that pipeline was `40 / (2 × 6)` = 3.3
 * searches a month. The owner's Booking tier was empty after a morning.
 *
 * A caller with a per-call estimate must multiply it by however many calls one search
 * makes before passing it here. For stays that count is bounded by
 * `maxStayLookupsPerSearch` below, which is the same arithmetic solved for the count
 * rather than for the verdict.
 *
 * `costPerSearch <= 0` is out of scope: a free source is `cost-aware-search.ts`'s `'free'`
 * tier already, decided before this is ever called.
 */
export function isQuotaGenerous(providerId: ProviderId, costPerSearch: number): boolean {
	if (costPerSearch <= 0) return true;
	const cap = getProviderCap(providerId);
	if (cap <= 0) return false; // no meaningful quota at all — always ask first
	return cap / costPerSearch >= MIN_SEARCHES_PER_MONTH_FOR_AUTO_RUN;
}

/**
 * How many stay lookups ONE search may spend on a provider and still leave the key good
 * for `MIN_SEARCHES_PER_MONTH_FOR_AUTO_RUN` searches this month — `isQuotaGenerous`'s
 * inequality solved for the lookup count instead of for a yes/no.
 *
 * This is the number that makes one click's cost bounded and knowable, which it was not
 * before issue #148: the pipeline fanned a stay lookup out across every connection
 * candidate it happened to be processing, so the cost of a search was set by how many
 * stopover cities the route graph returned rather than by any budget. Against the shipped
 * caps that yields:
 *
 *   Booking  floor(40  / (20 × 2)) = 1 lookup  ->  2 requests per search, worst case
 *   Agoda    floor(400 / (20 × 6)) = 3 lookups -> 18 requests per search, worst case
 *
 * Both hold whether the pipeline is processing 6 candidates or 24, which is the whole
 * point. A provider too tight to afford even one lookup per search gets `0` and is left
 * out of the auto-run set entirely, exactly as `isQuotaGenerous` would have left it out —
 * it still needs the explicit widen flow, never a silent "always runs".
 *
 * `Number.POSITIVE_INFINITY` for a free provider (`costPerLookup <= 0`): nothing to ration.
 */
export function maxStayLookupsPerSearch(providerId: ProviderId, costPerLookup: number): number {
	if (costPerLookup <= 0) return Number.POSITIVE_INFINITY;
	// The cheapest search that still uses this provider is one doing a single lookup. If
	// even that is too expensive to run unasked, the answer is zero lookups and the provider
	// keeps needing the explicit widen flow — asked of `isQuotaGenerous` directly rather
	// than restated here, so there is exactly one definition of "cheap enough to auto-run".
	if (!isQuotaGenerous(providerId, costPerLookup)) return 0;
	return Math.floor(getProviderCap(providerId) / (MIN_SEARCHES_PER_MONTH_FOR_AUTO_RUN * costPerLookup));
}
