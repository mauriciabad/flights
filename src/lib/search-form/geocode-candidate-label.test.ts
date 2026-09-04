import { describe, expect, it } from 'vitest';
import { describeGeocodeCandidate } from './geocode-candidate-label';
import type { GeocodeCandidate } from '$lib/providers/geocode/types';

function candidate(overrides: Partial<GeocodeCandidate>): GeocodeCandidate {
	return {
		name: 'Barcelona',
		coordinates: { latitude: 0, longitude: 0 },
		countryCode: undefined,
		timeZone: undefined,
		areas: [],
		...overrides
	};
}

describe('describeGeocodeCandidate', () => {
	it('tells the Spanish and Venezuelan Barcelona apart by country', () => {
		const spain = candidate({ countryCode: 'ES' });
		const venezuela = candidate({ countryCode: 'VE' });

		expect(describeGeocodeCandidate(spain)).toBe('Barcelona — Spain');
		expect(describeGeocodeCandidate(venezuela)).toBe('Barcelona — Venezuela');
		expect(describeGeocodeCandidate(spain)).not.toBe(describeGeocodeCandidate(venezuela));
	});

	it('adds the matched region ahead of the country when one is present', () => {
		const withRegion = candidate({
			countryCode: 'ES',
			areas: [
				{ name: 'España', adminLevel: 2, matched: true },
				{ name: 'Catalunya', adminLevel: 4, matched: true },
				{ name: 'Barcelona', adminLevel: 6, matched: true }
			]
		});

		expect(describeGeocodeCandidate(withRegion)).toBe('Barcelona — Catalunya, Spain');
	});

	it('ignores an unmatched area even if present', () => {
		const unmatchedRegion = candidate({
			countryCode: 'ES',
			areas: [{ name: 'Catalunya', adminLevel: 4, matched: false }]
		});

		expect(describeGeocodeCandidate(unmatchedRegion)).toBe('Barcelona — Spain');
	});

	it('falls back to the bare name when even the country is unknown', () => {
		expect(describeGeocodeCandidate(candidate({ countryCode: undefined }))).toBe('Barcelona');
	});
});
