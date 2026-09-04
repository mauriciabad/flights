import { describe, expect, it } from 'vitest';
import { buildSearchResultsDeepLink } from './skyscanner-deep-link';

describe('buildSearchResultsDeepLink', () => {
	it('builds a one-way skyscanner.net search URL for the route and date', () => {
		const link = buildSearchResultsDeepLink({
			origin: 'BCN',
			destination: 'VIE',
			departureDate: '2026-10-15',
			travellers: 1,
			currency: 'EUR'
		});
		expect(link).toBe(
			'https://www.skyscanner.net/transport/flights/bcn/vie/261015/?adultsv2=1&cabinclass=economy&currency=EUR&rtn=0'
		);
	});

	it('carries the traveller count through', () => {
		const link = buildSearchResultsDeepLink({
			origin: 'BCN',
			destination: 'VIE',
			departureDate: '2026-10-15',
			travellers: 3,
			currency: 'EUR'
		});
		expect(link).toContain('adultsv2=3');
	});

	it('clamps a non-positive traveller count to 1 rather than building an invalid link', () => {
		const link = buildSearchResultsDeepLink({
			origin: 'BCN',
			destination: 'VIE',
			departureDate: '2026-10-15',
			travellers: 0,
			currency: 'EUR'
		});
		expect(link).toContain('adultsv2=1');
	});
});
