import { beforeEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_PROVIDER_CAPS,
	FALLBACK_PROVIDER_CAP,
	clearProviderCapOverride,
	getProviderCap,
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
