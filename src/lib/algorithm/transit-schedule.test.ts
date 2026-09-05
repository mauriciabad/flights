import { describe, expect, it } from 'vitest';
import type { Duration, FlightOffer, LocalDateTime, Transfer, TransitSchedule } from '../domain';
import type { ItineraryParts } from './build';
import { readMissedService, readStaleSchedule } from './transit-schedule';

function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 };
}

function schedule(partial: Partial<TransitSchedule> & Pick<TransitSchedule, 'plannedFor'>): TransitSchedule {
	return { intended: at('2026-10-04T00:10:00'), following: [], ...partial };
}

const DEPART_AFTER = { time: at('2026-10-03T23:55:00'), arriveBy: false };
const ARRIVE_BY = { time: at('2026-10-04T06:15:00'), arriveBy: true };

describe('readMissedService', () => {
	it('calls an overnight gap what it is, with the next departure and how far off it is', () => {
		// The issue's own worked example: land at 23:40, ready at 23:55, catch the 00:10, and
		// the next one is not until 05:20.
		const missed = readMissedService(
			schedule({ plannedFor: DEPART_AFTER, following: [at('2026-10-04T05:20:00'), at('2026-10-04T05:50:00')] })
		);

		expect(missed.outcome).toBe('long-gap');
		expect(missed.next?.local).toBe('2026-10-04T05:20:00');
		expect(missed.gap).toBe(310);
	});

	it('treats a normal headway as a wait, not a crisis', () => {
		const missed = readMissedService(
			schedule({ plannedFor: DEPART_AFTER, following: [at('2026-10-04T00:22:00')] })
		);

		expect(missed.outcome).toBe('another-soon');
		expect(missed.gap).toBe(12);
	});

	it('says nothing later was FOUND, which is not the same claim as nothing later exists', () => {
		const missed = readMissedService(schedule({ plannedFor: DEPART_AFTER, following: [] }));
		expect(missed.outcome).toBe('last-known');
		expect(missed.next).toBeUndefined();
	});

	it('reads an empty `following` on an arriveBy plan as the deadline answer, not as a dead timetable', () => {
		// Same empty list, opposite meaning: every itinerary a deadline query returns arrives
		// in time, so there is nothing later to list. Missing this one costs the flight.
		const missed = readMissedService(
			schedule({ plannedFor: ARRIVE_BY, intended: at('2026-10-04T05:15:00'), following: [] })
		);
		expect(missed.outcome).toBe('last-in-time');
	});

	it('crosses a DST boundary using the offsets stored on each departure, not wall-clock subtraction', () => {
		// Europe/Madrid falls back at 03:00 on 2026-10-25: 02:30+02:00 to 02:30+01:00 is a
		// real hour apart even though the clocks read the same minute.
		const before: LocalDateTime = { local: '2026-10-25T02:30:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 };
		const after: LocalDateTime = { local: '2026-10-25T02:30:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 60 };

		const missed = readMissedService(schedule({ plannedFor: DEPART_AFTER, intended: before, following: [after] }));

		expect(missed.gap).toBe(60);
		expect(missed.outcome).toBe('long-gap');
	});
});

function flight(departure: string, arrival: string): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Test Air' },
		flightNumber: 'FR1',
		departureAirport: 'BVC',
		arrivalAirport: 'LGW',
		departure: at(departure),
		arrival: at(arrival),
		priceScope: 'per-person',
		duration: 300 as Duration,
		price: { minorUnits: 5000, currency: 'EUR' },
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	};
}

function busTo(plannedFor: LocalDateTime): Transfer {
	return {
		mode: 'transit',
		duration: 41 as Duration,
		source: 'transitous',
		transitSchedule: schedule({ plannedFor: { time: plannedFor, arriveBy: true } })
	};
}

/** The issue's own trip: a 2h connection buffer before a 3:20pm onward flight, so the
 * traveller has to be at the connection airport by 1:20pm. */
function trip(connectionWaitingTime: number): ItineraryParts {
	return {
		outboundFlight: flight('2026-10-06T08:00:00', '2026-10-06T11:00:00'),
		onwardFlight: flight('2026-10-06T15:20:00', '2026-10-06T18:00:00'),
		originWaitingTime: 120 as Duration,
		connectionWaitingTime: connectionWaitingTime as Duration,
		travellers: 1,
		transferToOriginAirport: busTo(at('2026-10-06T06:00:00')),
		transferToConnectionAirport: busTo(at('2026-10-06T13:20:00'))
	};
}

describe('readStaleSchedule', () => {
	it('stays quiet while the trip still happens at the moment the timetable was planned for', () => {
		expect(readStaleSchedule(trip(120), 'transferToConnectionAirport')).toBeUndefined();
		expect(readStaleSchedule(trip(120), 'transferToOriginAirport')).toBeUndefined();
	});

	it('reports the new deadline once a waiting-time edit moves it', () => {
		// Issue #266's repro: push the connection wait from 2h to 700m and the traveller now
		// has to be at the airport at 3:40am, while the row goes on quoting a 1:20pm timetable.
		expect(readStaleSchedule(trip(700), 'transferToConnectionAirport')?.local).toBe('2026-10-06T03:40:00');
	});

	it('leaves the untouched leg alone, so one edit does not discredit the whole trip', () => {
		expect(readStaleSchedule(trip(700), 'transferToOriginAirport')).toBeUndefined();
	});

	it('clears itself when the wait goes back, because nothing was flagged to reset', () => {
		expect(readStaleSchedule(trip(700), 'transferToConnectionAirport')).toBeDefined();
		expect(readStaleSchedule(trip(120), 'transferToConnectionAirport')).toBeUndefined();
	});

	it('says nothing about the two legs that start at a runway, whose moment it cannot derive', () => {
		// Issue #266's second half. `applyLandingBuffer` folds the walk-out time into the
		// transfer's duration, so the landing-plus-buffer moment is not on the itinerary and
		// guessing one here would be worse than saying nothing.
		const parts: ItineraryParts = { ...trip(700), transferToHotel: busTo(at('2026-10-06T11:15:00')) };
		expect(readStaleSchedule(parts, 'transferToHotel')).toBeUndefined();
	});

	it('has no opinion on a leg with no timetable at all', () => {
		const parts: ItineraryParts = { ...trip(700), transferToConnectionAirport: undefined };
		expect(readStaleSchedule(parts, 'transferToConnectionAirport')).toBeUndefined();
	});
});
