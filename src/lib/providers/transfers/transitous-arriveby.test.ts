/**
 * Issue #135: which departure the mapper calls "the" one, and in what order the rest come
 * back.
 *
 * The fixture is trimmed from a real `arriveBy=true` response captured on 2026-09-04 for
 * Plaça de Catalunya to Barcelona airport, planned for a 06:15 local check-in on Sunday
 * 4 October — the issue's own journey. It is the shape that matters here: MOTIS returned
 * seven itineraries in the order 02:16, 02:17, 02:40, 02:43, 02:31, 02:46, 03:08 (UTC), so
 * neither "the first entry" nor "already sorted" holds, and the app used to rely on both.
 */

import { describe, expect, it } from 'vitest';
import type { TransitPlanMoment } from '../../domain';
import { mapPlanResponseToTransfer } from './transitous-mapper';
import type { TransitousItinerary, TransitousPlanResponse } from './transitous-types';

const BCN = 'Europe/Madrid';

function busItinerary(startUtc: string, endUtc: string, line: string): TransitousItinerary {
	return {
		duration: 3000,
		startTime: startUtc,
		endTime: endUtc,
		transfers: 0,
		legs: [
			{
				mode: 'BUS',
				duration: 3000,
				startTime: startUtc,
				endTime: endUtc,
				routeShortName: line,
				agencyName: 'TMB',
				from: { name: 'Plaça de Catalunya', lat: 41.387, lon: 2.17, tz: BCN },
				to: { name: 'Aeroport BCN', lat: 41.2971, lon: 2.07846, tz: BCN }
			}
		]
	};
}

/** Out of order on purpose: this is the order the live API actually returned. */
const ARRIVE_BY_RESPONSE: TransitousPlanResponse = {
	itineraries: [
		busItinerary('2026-10-04T02:20:00Z', '2026-10-04T03:25:00Z', 'N18'),
		busItinerary('2026-10-04T02:50:00Z', '2026-10-04T03:29:00Z', 'L0145'),
		busItinerary('2026-10-04T02:35:00Z', '2026-10-04T03:40:00Z', 'N18'),
		busItinerary('2026-10-04T03:15:00Z', '2026-10-04T03:59:00Z', 'N1')
	]
};

/** Plaça de Catalunya to Barcelona airport in a straight line, the pair this fixture was
 * captured for. Issue #220's plausibility rule is measured against it; at this distance it
 * allows 2h 46m, and every bus here is 50 minutes. */
const BCN_AIRPORT_KM = 12.6;

const ARRIVE_BY_0615: TransitPlanMoment = {
	time: { local: '2026-10-04T06:15:00', timeZone: BCN, utcOffsetMinutes: 120 },
	arriveBy: true
};
const DEPART_AFTER_0400: TransitPlanMoment = {
	time: { local: '2026-10-04T04:00:00', timeZone: BCN, utcOffsetMinutes: 120 },
	arriveBy: false
};

describe('mapPlanResponseToTransfer, planned for a check-in deadline', () => {
	it('names the LAST departure that still arrives in time, not the first one listed', () => {
		const transfer = mapPlanResponseToTransfer(ARRIVE_BY_RESPONSE, ARRIVE_BY_0615, BCN_AIRPORT_KM);

		// 03:15Z is 05:15 in Barcelona: the latest bus that still lands the traveller at the
		// terminal before the 06:15 deadline, and therefore the one worth catching.
		expect(transfer?.transitSchedule?.intended.local).toBe('2026-10-04T05:15:00');
		expect(transfer?.transitSchedule?.arrival?.local).toBe('2026-10-04T05:59:00');
	});

	it('answers "what if you miss it" by leaving `following` empty and listing the earlier ones', () => {
		const schedule = mapPlanResponseToTransfer(ARRIVE_BY_RESPONSE, ARRIVE_BY_0615, BCN_AIRPORT_KM)?.transitSchedule;

		// Nothing later than the last workable departure arrives in time, by construction —
		// which is the answer, not a hole in the data.
		expect(schedule?.following).toEqual([]);
		// The safety margin, ascending: leave earlier if you want slack.
		expect(schedule?.earlier?.map((departure) => departure.local)).toEqual([
			'2026-10-04T04:20:00',
			'2026-10-04T04:35:00',
			'2026-10-04T04:50:00'
		]);
	});

	it('carries the moment it was planned for, so nothing downstream has to assume one', () => {
		const schedule = mapPlanResponseToTransfer(ARRIVE_BY_RESPONSE, ARRIVE_BY_0615, BCN_AIRPORT_KM)?.transitSchedule;
		expect(schedule?.plannedFor).toEqual(ARRIVE_BY_0615);
	});
});

describe('mapPlanResponseToTransfer, planned for a moment the traveller is free from', () => {
	it('names the FIRST departure and sorts the rest ascending', () => {
		const schedule = mapPlanResponseToTransfer(ARRIVE_BY_RESPONSE, DEPART_AFTER_0400, BCN_AIRPORT_KM)?.transitSchedule;

		expect(schedule?.intended.local).toBe('2026-10-04T04:20:00');
		// The bug the issue reported verbatim: "The 'next' list is also unsorted (13:28
		// before 13:27)." MOTIS's own order was 04:20, 04:50, 04:35, 05:15.
		expect(schedule?.following.map((departure) => departure.local)).toEqual([
			'2026-10-04T04:35:00',
			'2026-10-04T04:50:00',
			'2026-10-04T05:15:00'
		]);
		expect(schedule?.earlier).toBeUndefined();
	});

	it('collapses alternate routes that share one departure minute', () => {
		const withDuplicate: TransitousPlanResponse = {
			itineraries: [
				busItinerary('2026-10-04T04:20:00Z', '2026-10-04T05:10:00Z', 'N18'),
				busItinerary('2026-10-04T04:20:00Z', '2026-10-04T05:15:00Z', 'N14'),
				busItinerary('2026-10-04T04:50:00Z', '2026-10-04T05:29:00Z', 'L0145')
			]
		};

		const schedule = mapPlanResponseToTransfer(withDuplicate, DEPART_AFTER_0400, BCN_AIRPORT_KM)?.transitSchedule;

		// Two ways to describe the same 06:20 departure is not "the next one after it".
		expect(schedule?.following.map((departure) => departure.local)).toEqual(['2026-10-04T06:50:00']);
	});
});
