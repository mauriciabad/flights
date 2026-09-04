import { describe, expect, it } from 'vitest';
import type { FlightOffer } from '../domain';
import { describeFlightOptions } from './flight-picker-summary';

function flight(local: string, carrierName = 'Ryanair', carrierCode = 'FR'): FlightOffer {
	return {
		carrier: { iataCode: carrierCode, name: carrierName },
		flightNumber: `${carrierCode}1234`,
		departureAirport: 'BCN',
		arrivalAirport: 'BGY',
		departure: { local, timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
		arrival: { local, timeZone: 'Europe/Rome', utcOffsetMinutes: 120 },
		duration: 105 as FlightOffer['duration'],
		price: { minorUnits: 1499, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid'
	};
}

describe('describeFlightOptions', () => {
	it('says nothing when there is nothing to describe', () => {
		expect(describeFlightOptions([])).toBeUndefined();
	});

	// The sentence issue #137 is really about: one row must read as a fact about this
	// search, not as a claim that the route has a single flight.
	it('names a single result as a finding of the search, not a property of the route', () => {
		expect(describeFlightOptions([flight('2026-10-01T05:45:00')])).toBe(
			'Only one flight found on this route from Ryanair.'
		);
	});

	it('counts the flights, the distinct dates and the span they cover', () => {
		const flights = [
			flight('2026-10-01T05:45:00'),
			flight('2026-10-02T09:10:00'),
			flight('2026-10-02T18:30:00'),
			flight('2026-10-14T21:20:00')
		];
		expect(describeFlightOptions(flights)).toBe('4 flights across 3 dates, 1 Oct to 14 Oct from Ryanair.');
	});

	it('drops the range when every flight is on one day', () => {
		const flights = [flight('2026-10-01T05:45:00'), flight('2026-10-01T18:30:00')];
		expect(describeFlightOptions(flights)).toBe('2 flights on 1 Oct from Ryanair.');
	});

	it('reports the span from the earliest and latest dates whatever order they arrive in', () => {
		const flights = [flight('2026-11-03T05:45:00'), flight('2026-10-28T09:10:00')];
		expect(describeFlightOptions(flights)).toBe('2 flights across 2 dates, 28 Oct to 3 Nov from Ryanair.');
	});

	// Ryanair Holdings flies under several codes and the timetable feed says which, so a
	// picker can honestly hold flights from more than one of them.
	it('names two airlines, and counts rather than lists more than two', () => {
		expect(
			describeFlightOptions([flight('2026-10-01T05:45:00'), flight('2026-10-02T09:10:00', 'Ryanair UK', 'RK')])
		).toBe('2 flights across 2 dates, 1 Oct to 2 Oct from Ryanair and Ryanair UK.');

		expect(
			describeFlightOptions([
				flight('2026-10-01T05:45:00'),
				flight('2026-10-02T09:10:00', 'Ryanair UK', 'RK'),
				flight('2026-10-03T09:10:00', 'Buzz', 'RR')
			])
		).toBe('3 flights across 3 dates, 1 Oct to 3 Oct from 3 airlines.');
	});
});
