/**
 * Stored-shape fixtures for this directory's own tests, not exercised itself (no
 * `.test.ts` suffix, so vitest.config.ts's `include` pattern skips it). Same role and same
 * reasoning as `results/test-support.ts`: valid enough to load and render, with the one
 * field a given test cares about as an override.
 *
 * Deliberately built by hand rather than through `build.ts`. These tests are about what
 * `storage.ts` does with a list, and a fixture that went through the builder would tie them
 * to the builder's own correctness.
 */

import type { LocalDateTime, Money } from '$lib/domain';
import type { PriceObservation, SavedItinerary, SavedTrip } from './types';

export function money(minorUnits: number, currency = 'EUR'): Money {
	return { minorUnits, currency };
}

function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

export function makeTrip(overrides: Partial<SavedTrip> = {}): SavedTrip {
	return {
		origin: { airport: 'BCN', city: 'Barcelona' },
		connection: { airport: 'VIE', city: 'Vienna' },
		destination: { airport: 'OTP', city: 'Bucharest' },
		outboundFlight: {
			carrier: { iataCode: 'VY', name: 'Vueling' },
			flightNumber: 'VY100',
			departureAirport: 'BCN',
			arrivalAirport: 'VIE',
			departure: at('2026-10-14T09:00:00'),
			arrival: at('2026-10-14T11:20:00')
		},
		onwardFlight: {
			carrier: { iataCode: 'W6', name: 'Wizz Air' },
			flightNumber: 'W6200',
			departureAirport: 'VIE',
			arrivalAirport: 'OTP',
			departure: at('2026-10-16T18:00:00'),
			arrival: at('2026-10-16T20:35:00')
		},
		nightsInConnection: 2,
		groundLegs: [
			{ leg: 'transferToHotel', mode: 'transit' },
			{ leg: 'transferToConnectionAirport', mode: 'taxi' }
		],
		bed: { propertyName: 'Wombats Vienna', roomKind: 'private', rating: { value: 87, outOf: 100 } },
		travellers: 1,
		...overrides
	};
}

export function makeObservation(overrides: Partial<PriceObservation> = {}): PriceObservation {
	return {
		observedAt: 1_000,
		visit: 'v1',
		nights: 2,
		flights: money(11_800),
		bed: money(6_400),
		total: money(18_200),
		...overrides
	};
}

export function makeSaved(overrides: Partial<SavedItinerary> = {}): SavedItinerary {
	return {
		id: 'VIE@from=BCN&to=OTP',
		query: 'from=BCN&to=OTP',
		savedAt: 1_000,
		trip: makeTrip(),
		prices: [makeObservation()],
		...overrides
	};
}
