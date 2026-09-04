import { describe, expect, it } from 'vitest';
import { buildSearchResultsDeepLink } from './flights-sky-deep-link';

describe('buildSearchResultsDeepLink', () => {
	it('builds a Skyscanner search-results URL for the route and date', () => {
		const url = buildSearchResultsDeepLink({
			origin: 'BCN',
			destination: 'VIE',
			departureDate: '2026-09-19',
			travellers: 1,
			currency: 'EUR'
		});
		expect(url).toBe(
			'https://www.skyscanner.net/transport/flights/bcn/vie/260919/?adultsv2=1&cabinclass=economy&currency=EUR&rtn=0'
		);
	});

	it('never sends fewer than one traveller even if given 0', () => {
		const url = buildSearchResultsDeepLink({
			origin: 'BCN',
			destination: 'VIE',
			departureDate: '2026-09-19',
			travellers: 0,
			currency: 'EUR'
		});
		expect(url).toContain('adultsv2=1');
	});
});
