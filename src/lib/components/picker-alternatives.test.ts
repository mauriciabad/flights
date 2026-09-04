import { describe, expect, it } from 'vitest';
import { distinctFlightCount, flightKey, hasSwappableAlternatives } from './picker-alternatives';
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

describe('hasSwappableAlternatives', () => {
	const single = flight('FR846', '2026-10-08T05:45:00');
	const nothing = {
		outboundFlights: [single],
		onwardFlights: [flight('FR865', '2026-10-14T16:15:00')],
		transferCandidateCounts: [0, 0, 0, 0],
		stayPropertyCount: 0
	};

	it('is false on the search issue #140 was filed against: one flight per leg, no transport, no stays', () => {
		expect(hasSwappableAlternatives(nothing)).toBe(false);
	});

	it('is false when a leg has duplicates of a single real departure', () => {
		expect(hasSwappableAlternatives({ ...nothing, outboundFlights: [single, single] })).toBe(false);
	});

	it('is true as soon as one leg has a second flight time', () => {
		expect(
			hasSwappableAlternatives({
				...nothing,
				outboundFlights: [single, flight('FR848', '2026-10-08T14:20:00')]
			})
		).toBe(true);
	});

	it('is true when any one transfer leg has more than one mode to choose between', () => {
		expect(hasSwappableAlternatives({ ...nothing, transferCandidateCounts: [0, 2, 0, 0] })).toBe(true);
	});

	it('ignores a transfer leg with a single candidate, which renders as the current pick alone', () => {
		expect(hasSwappableAlternatives({ ...nothing, transferCandidateCounts: [1, 1, 1, 1] })).toBe(false);
	});

	it('counts a single stay property, since pricing it in or leaving it out is a real choice', () => {
		expect(hasSwappableAlternatives({ ...nothing, stayPropertyCount: 1 })).toBe(true);
	});
});
