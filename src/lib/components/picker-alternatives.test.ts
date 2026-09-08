import { describe, expect, it } from 'vitest';
import { distinctFlightCount, flightKey } from './picker-alternatives';
import type { FlightOffer, LocalDateTime } from '../domain';

function at(local: string): LocalDateTime {
	return { local, utcOffsetMinutes: 120 } as LocalDateTime;
}

function flight(flightNumber: string, departureLocal: string): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Ryanair' },
		flightNumber,
		departureAirport: 'BCN',
		arrivalAirport: 'BGY',
		departure: at(departureLocal),
		arrival: at('2026-10-08T07:30:00'),
		duration: 105,
		price: { minorUnits: 1499, currency: 'EUR' },
		priceScope: 'per-person'
	} as FlightOffer;
}

describe('flightKey', () => {
	it('treats the same departure sold by two providers as one option', () => {
		const a = flight('FR846', '2026-10-08T05:45:00');
		const b = flight('FR846', '2026-10-08T05:45:00');
		expect(flightKey(a)).toBe(flightKey(b));
	});

	it('keeps the same flight number on two different days apart', () => {
		const thursday = flight('FR846', '2026-10-08T05:45:00');
		const friday = flight('FR846', '2026-10-09T05:45:00');
		expect(flightKey(thursday)).not.toBe(flightKey(friday));
	});
});

describe('distinctFlightCount', () => {
	it('counts the rows the picker would draw, not the raw array', () => {
		const one = flight('FR846', '2026-10-08T05:45:00');
		expect(distinctFlightCount([one, one, one])).toBe(1);
		expect(distinctFlightCount([one, flight('FR848', '2026-10-08T14:20:00')])).toBe(2);
	});
});
