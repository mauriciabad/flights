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
	it('defaults each known provider below its measured free-tier limit', () => {
		// docs/PROVIDERS.md: Sky Scrapper 20/month, Flights Sky 50/month.
		expect(getProviderCap('sky-scrapper')).toBe(DEFAULT_PROVIDER_CAPS['sky-scrapper']);
		expect(getProviderCap('sky-scrapper')).toBeLessThan(20);
		expect(getProviderCap('flights-sky')).toBe(DEFAULT_PROVIDER_CAPS['flights-sky']);
		expect(getProviderCap('flights-sky')).toBeLessThan(50);
	});

	it('falls back to a conservative cap for an unlisted metered provider', () => {
		expect(getProviderCap('some-future-provider')).toBe(FALLBACK_PROVIDER_CAP);
	});

	it('prefers a stored override over the default', () => {
		setProviderCapOverride('sky-scrapper', 5);
		expect(getProviderCap('sky-scrapper')).toBe(5);
	});

	it('reverts to the default once an override is cleared', () => {
		setProviderCapOverride('sky-scrapper', 5);
		clearProviderCapOverride('sky-scrapper');
		expect(getProviderCap('sky-scrapper')).toBe(DEFAULT_PROVIDER_CAPS['sky-scrapper']);
	});

	it('reads as the default rather than throwing on corrupted stored overrides', () => {
		localStorage.setItem('flights.providerBudget.caps.v1', 'not json{{{');
		expect(getProviderCap('sky-scrapper')).toBe(DEFAULT_PROVIDER_CAPS['sky-scrapper']);
	});
});
