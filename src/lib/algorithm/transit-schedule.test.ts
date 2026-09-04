import { describe, expect, it } from 'vitest';
import type { LocalDateTime, TransitSchedule } from '../domain';
import { readMissedService } from './transit-schedule';

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
