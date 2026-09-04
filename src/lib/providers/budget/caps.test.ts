import { beforeEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_PROVIDER_CAPS,
	FALLBACK_PROVIDER_CAP,
	clearProviderCapOverride,
	getProviderCap,
	isQuotaGenerous,
	setProviderCapOverride
} from './caps';

beforeEach(() => {
	localStorage.clear();
});

describe('getProviderCap', () => {
	it('defaults each real adapter id below its measured free-tier limit', () => {
		// docs/PROVIDERS.md: Sky Scrapper 20/month, Flights Sky 50/month, Kiwi 300/month,
		// Agoda 500/month, Booking.com 50/month.
		// Issue #69: keyed by each adapter's own `ProviderId` (`skyscanner`, `flights-sky`,
		// `kiwi`, `agoda`, `booking`), not the RapidAPI host slugs the table used to be keyed by.
		expect(getProviderCap('skyscanner')).toBe(DEFAULT_PROVIDER_CAPS.skyscanner);
		expect(getProviderCap('skyscanner')).toBeLessThan(20);
		expect(getProviderCap('flights-sky')).toBe(DEFAULT_PROVIDER_CAPS['flights-sky']);
		expect(getProviderCap('flights-sky')).toBeLessThan(50);
		expect(getProviderCap('kiwi')).toBe(DEFAULT_PROVIDER_CAPS.kiwi);
		expect(getProviderCap('kiwi')).toBeLessThan(300);
		expect(getProviderCap('agoda')).toBe(DEFAULT_PROVIDER_CAPS.agoda);
		expect(getProviderCap('agoda')).toBeLessThan(500);
		expect(getProviderCap('booking')).toBe(DEFAULT_PROVIDER_CAPS.booking);
		expect(getProviderCap('booking')).toBeLessThan(50);
	});

	it('gives Agoda a much larger cap than the flight providers, matching how much bigger its real quota is', () => {
		// docs/PROVIDERS.md calls this out explicitly: "Agoda's 500 is the outlier and worth
		// exploiting... do not apply one budget policy across all providers."
		expect(getProviderCap('agoda')).toBeGreaterThan(getProviderCap('skyscanner') * 10);
	});

	it('falls back to a conservative cap for a real adapter id with no tuned entry', () => {
		// Ryanair, Transitous and OSRM are keyless and unmetered, so caps.ts tunes no entry
		// for them — this proves the fallback still applies rather than a lookup miss
		// throwing or returning undefined.
		expect(getProviderCap('ryanair')).toBe(FALLBACK_PROVIDER_CAP);
	});

	it('prefers a stored override over the default', () => {
		setProviderCapOverride('skyscanner', 5);
		expect(getProviderCap('skyscanner')).toBe(5);
	});

	it('reverts to the default once an override is cleared', () => {
		setProviderCapOverride('skyscanner', 5);
		clearProviderCapOverride('skyscanner');
		expect(getProviderCap('skyscanner')).toBe(DEFAULT_PROVIDER_CAPS.skyscanner);
	});

	it('reads as the default rather than throwing on corrupted stored overrides', () => {
		localStorage.setItem('flights.providerBudget.caps.v1', 'not json{{{');
		expect(getProviderCap('skyscanner')).toBe(DEFAULT_PROVIDER_CAPS.skyscanner);
	});

	it('a mistyped or drifted provider id fails to compile, rather than silently missing the cap table', () => {
		// This is issue #69 itself: `DEFAULT_PROVIDER_CAPS` used to be keyed by RapidAPI's
		// host slugs while adapters used their own brand ids, so `getProviderCap('skyscanner')`
		// silently returned `FALLBACK_PROVIDER_CAP` instead of the tuned 15. `ProviderId`
		// (../types.ts) is a closed union specifically so a call like this one is a compile
		// error — caught by `pnpm check` failing if the line below ever stops needing this
		// `@ts-expect-error` — rather than a lookup miss only caught by reading the number.
		// @ts-expect-error 'flights-skyy' is not a real ProviderId.
		expect(getProviderCap('flights-skyy')).toBe(FALLBACK_PROVIDER_CAP);
	});
});

describe('isQuotaGenerous (issues #94, #148)', () => {
	it('is always generous for a zero-cost source, regardless of cap', () => {
		expect(isQuotaGenerous('skyscanner', 0)).toBe(true);
	});

	it('keeps Sky Scrapper requiring explicit consent — its cap cannot absorb even one date-range search cheaply', () => {
		// Sky Scrapper's real cost is one request per date in the range; even the cheapest
		// possible case, a single date, is 1. 15 (its default cap) ÷ 1 = 15 searches/month,
		// below the 20 this function requires — this is the exact number that must keep
		// failing for Sky Scrapper's explicit-consent flow (pipeline.ts's "confirm" tier)
		// to still work after issue #94.
		expect(isQuotaGenerous('skyscanner', 1)).toBe(false);
	});

	it('lets a one-lookup Agoda search run with no extra consent', () => {
		// One lookup costs 1 search + up to 5 get-prices drill-downs (agoda.ts's
		// MAX_CANDIDATES_TO_EXPAND) = 6. Cap 400 ÷ 6 ≈ 66.7 such searches/month.
		expect(isQuotaGenerous('agoda', 6)).toBe(true);
	});

	it('lets a one-lookup Booking search run with no extra consent, exactly at the threshold', () => {
		// One lookup costs 1 search + 1 getRoomList drill-down = 2. Cap 40 ÷ 2 = exactly 20.
		expect(isQuotaGenerous('booking', 2)).toBe(true);
	});

	it('refuses the SIX-lookup Booking search the pipeline actually used to make (issue #148)', () => {
		// The regression this argument's meaning was corrected for. `pipeline.ts` ran a stay
		// lookup per connection candidate — six ordinarily — so one search really cost
		// 6 × 2 = 12 Booking requests, which a cap of 40 sustains three times, not twenty.
		// Passing the per-call cost here reported `true` and let it run anyway.
		expect(isQuotaGenerous('booking', 2 * 6)).toBe(false);
	});

	it('refuses the twenty-four-lookup Booking search the fallback sweep used to make (issue #148)', () => {
		// `FALLBACK_MAX_CANDIDATES` is 24, and that path fires precisely when a search found
		// nothing — 48 requests, the whole free tier, from one click.
		expect(isQuotaGenerous('booking', 2 * 24)).toBe(false);
	});

	it('treats a provider whose cap has been driven to zero as never quota-generous', () => {
		setProviderCapOverride('skyscanner', 0);
		expect(isQuotaGenerous('skyscanner', 1)).toBe(false);
	});

	it('respects a stored cap override, not just the default', () => {
		// A traveller who lowers Booking's cap to something Sky-Scrapper-tight should get
		// Sky Scrapper's own treatment: explicit consent, not a silent auto-run.
		setProviderCapOverride('booking', 15);
		expect(isQuotaGenerous('booking', 2)).toBe(false);
	});
});
