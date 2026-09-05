import { describe, expect, it } from 'vitest';
import type { Duration, FlightOffer, LocalDateTime, Transfer, TransitSchedule } from '../domain';
import type { ItineraryParts } from './build';
import { readMissedService, readStaleSchedule, transitDepartureWait } from './transit-schedule';

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
		legs: [],
		transitSchedule: schedule({ plannedFor: { time: plannedFor, arriveBy: true } })
	};
}

/** A leg that starts at a runway, carrying the walk-out time `applyLandingBuffer` folded
 * into its duration. `landingBuffer` is what lets the moment be re-derived from the
 * flight's arrival after a swap. */
function busFrom(plannedFor: LocalDateTime, landingBuffer: number): Transfer {
	return {
		mode: 'transit',
		duration: (35 + landingBuffer) as Duration,
		landingBuffer: landingBuffer as Duration,
		legs: [],
		transitSchedule: schedule({ plannedFor: { time: plannedFor, arriveBy: false } })
	};
}

/** The issue's own trip: a 2h connection buffer before a 3:20pm onward flight, so the
 * traveller has to be at the connection airport by 1:20pm. The outbound lands at 11am and
 * the onward at 6pm, so the two runway legs were planned for 11:30am (a 30-minute walk-out
 * at a large connection airport) and 6:15pm (15 minutes at a small destination one). */
function trip(connectionWaitingTime: number): ItineraryParts {
	return {
		outboundFlight: flight('2026-10-06T08:00:00', '2026-10-06T11:00:00'),
		onwardFlight: flight('2026-10-06T15:20:00', '2026-10-06T18:00:00'),
		originWaitingTime: 120 as Duration,
		connectionWaitingTime: connectionWaitingTime as Duration,
		travellers: 1,
		transferToOriginAirport: busTo(at('2026-10-06T06:00:00')),
		transferToHotel: busFrom(at('2026-10-06T11:30:00'), 30),
		transferToConnectionAirport: busTo(at('2026-10-06T13:20:00')),
		transferToDestinationLocation: busFrom(at('2026-10-06T18:15:00'), 15)
	};
}

describe('readStaleSchedule', () => {
	it('stays quiet while the trip still happens at the moment the timetable was planned for', () => {
		expect(readStaleSchedule(trip(120), 'transferToConnectionAirport')).toBeUndefined();
		expect(readStaleSchedule(trip(120), 'transferToOriginAirport')).toBeUndefined();
		expect(readStaleSchedule(trip(120), 'transferToHotel')).toBeUndefined();
		expect(readStaleSchedule(trip(120), 'transferToDestinationLocation')).toBeUndefined();
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

	it('leaves both runway legs alone on a waiting-time edit, which cannot move a landing', () => {
		// The whole reason the runway half needed a different mechanism: 700 minutes of
		// connection buffer moves the deadline legs and neither of these.
		expect(readStaleSchedule(trip(700), 'transferToHotel')).toBeUndefined();
		expect(readStaleSchedule(trip(700), 'transferToDestinationLocation')).toBeUndefined();
	});

	it('reports the new landing moment once a flight swap moves the outbound arrival', () => {
		// Issue #266's second half. Pick an outbound that lands at 1pm instead of 11am and
		// the traveller is out of the terminal at 1:30pm, while the row goes on listing the
		// departures behind 11:30am.
		const parts: ItineraryParts = {
			...trip(120),
			outboundFlight: flight('2026-10-06T10:00:00', '2026-10-06T13:00:00')
		};
		expect(readStaleSchedule(parts, 'transferToHotel')?.local).toBe('2026-10-06T13:30:00');
		// One swap, one stale leg. The destination-side timetable is about a different flight.
		expect(readStaleSchedule(parts, 'transferToDestinationLocation')).toBeUndefined();
	});

	it('reports the new landing moment on the destination leg, at its own airport buffer', () => {
		const parts: ItineraryParts = {
			...trip(120),
			onwardFlight: flight('2026-10-06T15:20:00', '2026-10-06T19:40:00')
		};
		expect(readStaleSchedule(parts, 'transferToDestinationLocation')?.local).toBe('2026-10-06T19:55:00');
	});

	it('clears the runway leg too when the flight goes back, since nothing was flagged', () => {
		const swapped: ItineraryParts = {
			...trip(120),
			outboundFlight: flight('2026-10-06T10:00:00', '2026-10-06T13:00:00')
		};
		expect(readStaleSchedule(swapped, 'transferToHotel')).toBeDefined();
		expect(readStaleSchedule(trip(120), 'transferToHotel')).toBeUndefined();
	});

	it('says nothing about a runway leg whose transfer never carried a landing buffer', () => {
		// A `Transfer` that never went through `applyLandingBuffer` has no walk-out time to
		// re-derive the moment from, and guessing one would be worse than saying nothing.
		const parts: ItineraryParts = {
			...trip(120),
			outboundFlight: flight('2026-10-06T10:00:00', '2026-10-06T13:00:00'),
			transferToHotel: { ...busFrom(at('2026-10-06T11:30:00'), 30), landingBuffer: undefined }
		};
		expect(readStaleSchedule(parts, 'transferToHotel')).toBeUndefined();
	});

	it('has no opinion on a leg with no timetable at all', () => {
		const parts: ItineraryParts = { ...trip(700), transferToConnectionAirport: undefined };
		expect(readStaleSchedule(parts, 'transferToConnectionAirport')).toBeUndefined();
	});
});

describe('transitDepartureWait (issue #344)', () => {
	/** The fixture trip with one runway leg's first departure moved to a named clock, which
	 * is the only input this question has beyond the flight it hangs off. */
	function departingAt(intended: string, field: 'transferToHotel' | 'transferToDestinationLocation'): ItineraryParts {
		const parts = trip(120);
		const leg = parts[field]!;
		return {
			...parts,
			[field]: {
				...leg,
				transitSchedule: { ...leg.transitSchedule!, intended: at(intended) }
			}
		};
	}

	it('measures the wait from the landing, the same anchor the picker names', () => {
		// The owner's own case from the other end: land at 11am, and the first bus this
		// timetable offers is at 5:49am the next morning. The row's clock alone says 5:49am
		// and nothing about the eighteen hours in front of it.
		expect(transitDepartureWait(departingAt('2026-10-07T05:49:00', 'transferToHotel'), 'transferToHotel')).toBe(
			18 * 60 + 49
		);
	});

	it('is quiet about an ordinary wait, which the caller then says nothing about', () => {
		expect(transitDepartureWait(departingAt('2026-10-06T11:12:00', 'transferToHotel'), 'transferToHotel')).toBe(12);
	});

	it('follows the flight when a swap moves the landing', () => {
		const parts: ItineraryParts = {
			...departingAt('2026-10-06T14:30:00', 'transferToHotel'),
			outboundFlight: flight('2026-10-06T10:00:00', '2026-10-06T13:00:00')
		};
		expect(transitDepartureWait(parts, 'transferToHotel')).toBe(90);
	});

	it('reads each runway leg against its own flight', () => {
		// The destination leg hangs off the onward landing at 6pm, not the outbound one at 11am.
		const parts = departingAt('2026-10-06T19:30:00', 'transferToDestinationLocation');
		expect(transitDepartureWait(parts, 'transferToDestinationLocation')).toBe(90);
	});

	it('says nothing about a leg that ends at a gate, which has no wait of this kind', () => {
		// An `arriveBy` answer is a departure chosen backwards from a deadline. The traveller
		// leaves when it leaves, and "3h after you land" would be nonsense about it.
		expect(transitDepartureWait(trip(120), 'transferToConnectionAirport')).toBeUndefined();
		expect(transitDepartureWait(trip(120), 'transferToOriginAirport')).toBeUndefined();
	});

	it('says nothing about a leg with no timetable at all', () => {
		const parts: ItineraryParts = {
			...trip(120),
			transferToHotel: { mode: 'taxi', duration: 35 as Duration, legs: [] }
		};
		expect(transitDepartureWait(parts, 'transferToHotel')).toBeUndefined();
	});

	it('never goes negative on a departure before the landing', () => {
		// A stale schedule can outlive the flight it was planned for (#266), and this question
		// is asked on rows the timeline draws before it knows that. Zero, never a count of
		// minutes into the past.
		expect(transitDepartureWait(departingAt('2026-10-06T09:00:00', 'transferToHotel'), 'transferToHotel')).toBe(0);
	});
});
