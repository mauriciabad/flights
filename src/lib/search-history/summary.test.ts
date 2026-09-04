import { describe, expect, it } from 'vitest';
import type { IataAirportCode, IsoCalendarDate, SearchQuery } from '$lib/domain';
import { formatDateRange, formatTravellers, summarizeSearch } from './summary';

describe('formatDateRange', () => {
	it.each([
		['2026-10-06', '2026-10-06', '6 Oct 2026'],
		['2026-10-01', '2026-10-20', '1 Oct to 20 Oct 2026'],
		['2026-09-28', '2026-10-03', '28 Sep to 3 Oct 2026'],
		['2026-12-28', '2027-01-03', '28 Dec 2026 to 3 Jan 2027']
	])('%s to %s reads as %s', (from, to, expected) => {
		expect(formatDateRange(from, to)).toBe(expected);
	});

	it('hands back whatever it was given when the dates are not dates', () => {
		expect(formatDateRange('soon', 'later')).toBe('soon to later');
	});
});

describe('formatTravellers', () => {
	it.each([
		[undefined, '1 traveller'],
		[1, '1 traveller'],
		[3, '3 travellers']
	])('%s reads as %s', (count, expected) => {
		expect(formatTravellers(count)).toBe(expected);
	});
});

describe('summarizeSearch', () => {
	it('says the route, the window and the party size in one line', () => {
		const query: SearchQuery = {
			soonestDeparture: '2026-10-06' as IsoCalendarDate,
			latestArrival: '2026-10-12' as IsoCalendarDate,
			originAirport: 'BVC' as IataAirportCode,
			destinationAirport: 'PFO' as IataAirportCode,
			travellers: 2
		};
		expect(summarizeSearch(query)).toEqual({
			originAirport: 'BVC',
			destinationAirport: 'PFO',
			dates: '6 Oct to 12 Oct 2026',
			travellers: '2 travellers',
			travellerCount: 2,
			label: 'BVC to PFO, 6 Oct to 12 Oct 2026, 2 travellers'
		});
	});
});
