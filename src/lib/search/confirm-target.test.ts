import { describe, expect, it } from 'vitest';
import type { Itinerary, SearchQuery } from '../domain';
import { makeItinerary } from '../results/test-support';
import { confirmTargetFor, narrowToConfirmTarget } from './confirm-target';

/** The acceptance search's own shape (docs/ACCEPTANCE.md): leaves 6-9 October, must be in
 * Pafos by the 12th. Four departure days and seven arrival days, which is where issue
 * #244's 11-requests-a-stopover quote came from. */
const QUERY: SearchQuery = {
	soonestDeparture: '2026-10-06',
	latestDeparture: '2026-10-09',
	latestArrival: '2026-10-12',
	originAirport: 'BVC',
	destinationAirport: 'PFO'
};

function itineraryDeparting(outboundLocal: string, onwardLocal: string): Itinerary {
	const itinerary = makeItinerary();
	return {
		...itinerary,
		outboundFlight: { ...itinerary.outboundFlight, departure: { ...itinerary.outboundFlight.departure, local: outboundLocal } },
		onwardFlight: { ...itinerary.onwardFlight, departure: { ...itinerary.onwardFlight.departure, local: onwardLocal } }
	};
}

describe('confirmTargetFor', () => {
	it('takes one date per leg off the itinerary already on screen', () => {
		const target = confirmTargetFor('LGW', QUERY, itineraryDeparting('2026-10-07T06:20:00', '2026-10-10T18:45:00'));

		expect(target).toEqual({
			candidateAirportCode: 'LGW',
			outboundDeparture: { earliest: '2026-10-07', latest: '2026-10-07' },
			onwardDeparture: { earliest: '2026-10-10', latest: '2026-10-10' }
		});
	});

	/** Every candidate on issue #115's fallback sweep is in this state: ranked by a free
	 * source, never priced, so there is no flight to read a date off. */
	it('falls back to the search query soonest dates for a candidate with nothing priced yet', () => {
		const target = confirmTargetFor('LGW', QUERY);

		expect(target.outboundDeparture).toEqual({ earliest: '2026-10-06', latest: '2026-10-06' });
		expect(target.onwardDeparture).toEqual({ earliest: '2026-10-06', latest: '2026-10-06' });
	});

	it('prefers an explicit soonestArrival over the departure date for the onward leg', () => {
		const target = confirmTargetFor('LGW', { ...QUERY, soonestArrival: '2026-10-08' });
		expect(target.onwardDeparture).toEqual({ earliest: '2026-10-08', latest: '2026-10-08' });
	});
});

describe('narrowToConfirmTarget', () => {
	it('narrows all four date fields, so neither leg keeps a range', () => {
		const target = confirmTargetFor('LGW', QUERY, itineraryDeparting('2026-10-07T06:20:00', '2026-10-10T18:45:00'));
		const narrowed = narrowToConfirmTarget(QUERY, target);

		// Both pairs collapsed. `onwardLegQuery` reads the arrival pair, and leaving it alone
		// is what kept the onward leg spanning seven dates while a comment claimed the range
		// had been narrowed (issue #244).
		expect(narrowed.soonestDeparture).toBe('2026-10-07');
		expect(narrowed.latestDeparture).toBe('2026-10-07');
		expect(narrowed.soonestArrival).toBe('2026-10-10');
		expect(narrowed.latestArrival).toBe('2026-10-10');
	});

	it('leaves everything that is not a date alone', () => {
		const query: SearchQuery = { ...QUERY, travellers: 3, forbiddenConnectionCountries: ['GB'] };
		const narrowed = narrowToConfirmTarget(query, confirmTargetFor('LGW', query));

		expect(narrowed.travellers).toBe(3);
		expect(narrowed.forbiddenConnectionCountries).toEqual(['GB']);
		expect(narrowed.originAirport).toBe('BVC');
		expect(narrowed.destinationAirport).toBe('PFO');
	});
});
