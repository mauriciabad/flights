import { describe, expect, it } from 'vitest';
import type { Duration, Transfer } from '$lib/domain';
import { makeItinerary, makeStopover } from '$lib/results/test-support';
import { buildPriceObservation, buildSavedItinerary, newVisitToken } from './build';
import { savedItineraryId } from './storage';

function taxi(minorUnits?: number): Transfer {
	return {
		mode: 'taxi',
		duration: 20 as Duration,
		legs: [{ mode: 'taxi', duration: 20 as Duration }],
		price: minorUnits === undefined ? undefined : { minorUnits, currency: 'EUR' }
	};
}

describe('buildSavedItinerary', () => {
	it('derives the same id the results page would compute from the card alone', () => {
		const entry = buildSavedItinerary({
			query: 'from=BCN&to=OTP',
			itinerary: makeItinerary(),
			visit: 'v1'
		});
		expect(entry.id).toBe(savedItineraryId('from=BCN&to=OTP', 'VIE'));
	});

	it('snapshots both flights, the route and the nights', () => {
		const entry = buildSavedItinerary({
			query: 'q=1',
			itinerary: makeStopover({ nightsInConnection: 2 }),
			visit: 'v1'
		});
		expect(entry.trip.origin.airport).toBe('BCN');
		expect(entry.trip.connection.airport).toBe('VIE');
		expect(entry.trip.destination.airport).toBe('OTP');
		expect(entry.trip.outboundFlight.flightNumber).toBe('VY100');
		expect(entry.trip.onwardFlight.carrier.iataCode).toBe('W6');
		expect(entry.trip.nightsInConnection).toBe(2);
	});

	it('names the connection city when the page has resolved the airport, and the code when it has not', () => {
		const itinerary = makeItinerary();
		expect(buildSavedItinerary({ query: 'q=1', itinerary, visit: 'v1' }).trip.connection.city).toBe('VIE');
		const resolved = buildSavedItinerary({
			query: 'q=1',
			itinerary,
			visit: 'v1',
			connectionAirport: {
				iataCode: 'VIE',
				name: 'Vienna',
				coordinates: { latitude: 48, longitude: 16 },
				city: { name: 'Vienna', country: { isoCode: 'AT', name: 'Austria' } },
				country: { isoCode: 'AT', name: 'Austria' },
				sizeClass: 'large'
			}
		});
		expect(resolved.trip.connection.city).toBe('Vienna');
	});

	it('records the mode of every ground leg, in trip order', () => {
		const entry = buildSavedItinerary({
			query: 'q=1',
			itinerary: makeStopover({ transferToConnectionAirport: taxi() }),
			visit: 'v1'
		});
		expect(entry.trip.groundLegs).toEqual([
			{ leg: 'transferToHotel', mode: 'walk' },
			{ leg: 'transferToConnectionAirport', mode: 'taxi' }
		]);
	});

	it('keeps the bed as a name, a room kind and its own rating scale', () => {
		const entry = buildSavedItinerary({ query: 'q=1', itinerary: makeStopover(), visit: 'v1' });
		expect(entry.trip.bed).toEqual({ propertyName: 'Test stay', roomKind: 'private', rating: undefined });
	});

	it('has no bed and no ground legs on a connection the traveller never leaves the airport for', () => {
		const entry = buildSavedItinerary({
			query: 'q=1',
			itinerary: makeItinerary({ nightsInConnection: 0 }),
			visit: 'v1'
		});
		expect(entry.trip.bed).toBeUndefined();
		expect(entry.trip.groundLegs).toEqual([]);
	});

	it('opens the price log with what the trip cost at the moment it was saved', () => {
		const entry = buildSavedItinerary({
			query: 'q=1',
			itinerary: makeStopover({ nightsInConnection: 2 }),
			visit: 'v1',
			savedAt: 5_000
		});
		expect(entry.prices).toHaveLength(1);
		expect(entry.prices[0]).toMatchObject({ observedAt: 5_000, visit: 'v1', nights: 2 });
	});
});

describe('buildPriceObservation', () => {
	it('splits the total into parts that add back up to it', () => {
		const itinerary = makeStopover({ nightsInConnection: 3 });
		const observation = buildPriceObservation({ itinerary, visit: 'v1' });
		const parts =
			(observation.flights?.minorUnits ?? 0) +
			(observation.bed?.minorUnits ?? 0) +
			(observation.ground?.minorUnits ?? 0);
		expect(parts).toBe(itinerary.totalPrice.minorUnits);
		expect(observation.total).toEqual(itinerary.totalPrice);
	});

	it('scales both fares to the party the way the itinerary builder did', () => {
		const itinerary = makeStopover({ travellers: 3 });
		expect(buildPriceObservation({ itinerary, visit: 'v1' }).flights).toEqual({
			minorUnits: (6000 + 5800) * 3,
			currency: 'EUR'
		});
	});

	it('leaves the bed out entirely on a trip that books none', () => {
		const observation = buildPriceObservation({
			itinerary: makeItinerary({ nightsInConnection: 0 }),
			visit: 'v1'
		});
		// Absent, never a zero: "no bed was priced" and "the bed was free" are different
		// facts, and a stored zero says the second one.
		expect(observation.bed).toBeUndefined();
	});

	it('leaves the ground out when no provider quoted a ride', () => {
		expect(buildPriceObservation({ itinerary: makeStopover(), visit: 'v1' }).ground).toBeUndefined();
	});

	it('sums the rides a provider did quote', () => {
		const itinerary = makeStopover({
			transferToHotel: taxi(1_200),
			transferToConnectionAirport: taxi(1_500)
		});
		expect(buildPriceObservation({ itinerary, visit: 'v1' }).ground).toEqual({
			minorUnits: 2_700,
			currency: 'EUR'
		});
	});

	it('carries the nights it was priced at, so two rows at two lengths are legible', () => {
		expect(buildPriceObservation({ itinerary: makeStopover({ nightsInConnection: 4 }), visit: 'v1' }).nights).toBe(4);
	});
});

describe('newVisitToken', () => {
	it('is a different token every time, so one tab cannot mint a repeat', () => {
		expect(newVisitToken(1_000)).not.toBe(newVisitToken(1_000));
	});
});
