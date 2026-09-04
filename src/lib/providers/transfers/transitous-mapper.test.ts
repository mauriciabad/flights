import { describe, expect, it } from 'vitest';
import { mapPlanResponseToTransfer, TransitousMapMalformedResponseError } from './transitous-mapper';
import type { TransitPlanMoment } from '../../domain';
import type { TransitousPlanResponse } from './transitous-types';

/**
 * Fixtures below are trimmed from real `/api/v1/plan` responses captured on 2026-09-04
 * (routing geometry, walking turn-by-turn steps and the `debugOutput` counters block
 * removed — this adapter reads none of them). Real values matter here specifically
 * because the whole point of this adapter is trusting what a live GTFS feed actually
 * says, not a plausible-looking guess at its shape.
 */

const DAYTIME_BARCELONA_RESPONSE: TransitousPlanResponse = {
	itineraries: [
		{
			duration: 3120,
			startTime: '2026-09-10T09:01:00Z',
			endTime: '2026-09-10T09:53:00Z',
			transfers: 1,
			legs: [
				{
					mode: 'WALK',
					duration: 60,
					startTime: '2026-09-10T09:01:00Z',
					endTime: '2026-09-10T09:02:00Z',
					distance: 38,
					from: { name: 'START', lat: 41.3874, lon: 2.1686, tz: 'Europe/Madrid' },
					to: { name: 'Catalunya', lat: 41.38749, lon: 2.168995, tz: 'Europe/Madrid' }
				},
				{
					mode: 'SUBWAY',
					duration: 1320,
					startTime: '2026-09-10T09:02:00Z',
					endTime: '2026-09-10T09:24:00Z',
					routeShortName: 'L1',
					routeLongName: 'Hospital de Bellvitge - Fondo',
					headsign: 'Hospital de Bellvitge',
					agencyName: 'TMB',
					from: { name: 'Catalunya', lat: 41.38749, lon: 2.168995, tz: 'Europe/Madrid' },
					to: { name: 'Hospital de Bellvitge', lat: 41.344677, lon: 2.107242, tz: 'Europe/Madrid' }
				},
				{
					mode: 'WALK',
					duration: 180,
					startTime: '2026-09-10T09:24:00Z',
					endTime: '2026-09-10T09:27:00Z',
					distance: 341,
					from: { name: 'Hospital de Bellvitge', lat: 41.344677, lon: 2.107242, tz: 'Europe/Madrid' },
					to: { name: 'Hospital de Bellvitge', lat: 41.343166, lon: 2.105187, tz: 'Europe/Madrid' }
				},
				{
					mode: 'BUS',
					duration: 540,
					startTime: '2026-09-10T09:29:00Z',
					endTime: '2026-09-10T09:38:00Z',
					routeShortName: '46',
					routeLongName: 'Pl. Espanya / Aeroport BCN',
					headsign: 'Aeroport BCN',
					agencyName: 'TMB',
					from: { name: 'Hospital de Bellvitge', lat: 41.343166, lon: 2.105187, tz: 'Europe/Madrid' },
					to: { name: 'Aeroport T2B - Sortides (sentit T1)', lat: 41.30287, lon: 2.075775, tz: 'Europe/Madrid' }
				},
				{
					mode: 'WALK',
					duration: 900,
					startTime: '2026-09-10T09:38:00Z',
					endTime: '2026-09-10T09:53:00Z',
					distance: 1069,
					from: { name: 'Aeroport T2B - Sortides (sentit T1)', lat: 41.30287, lon: 2.075775, tz: 'Europe/Madrid' },
					to: { name: 'END', lat: 41.2971, lon: 2.0785, tz: 'Europe/Madrid' }
				}
			]
		},
		{
			duration: 2880,
			startTime: '2026-09-10T09:05:00Z',
			endTime: '2026-09-10T09:53:00Z',
			transfers: 2,
			legs: [
				{
					mode: 'SUBWAY',
					duration: 360,
					startTime: '2026-09-10T09:06:00Z',
					endTime: '2026-09-10T09:12:00Z',
					routeShortName: 'L1',
					from: { name: 'Catalunya', lat: 41.38749, lon: 2.168995, tz: 'Europe/Madrid' },
					to: { name: 'Espanya', lat: 41.37551, lon: 2.149382, tz: 'Europe/Madrid' }
				}
			]
		},
		{
			duration: 3120,
			startTime: '2026-09-10T09:14:00Z',
			endTime: '2026-09-10T10:06:00Z',
			transfers: 1,
			legs: [
				{
					mode: 'BUS',
					duration: 900,
					startTime: '2026-09-10T09:18:00Z',
					endTime: '2026-09-10T09:33:00Z',
					routeShortName: 'L95',
					agencyName: 'Avanza',
					from: { name: 'Rda. Universitat', lat: 41.387177, lon: 2.167674, tz: 'Europe/Madrid' },
					to: { name: 'Av Granvia', lat: 41.354973, lon: 2.122077, tz: 'Europe/Madrid' }
				}
			]
		}
	]
};

/**
 * The exact "last bus" case the issue is about: requested at 01:00Z (03:00 local), the
 * earliest bus Transitous actually found doesn't leave until 05:03Z (07:03 local) — Besalú
 * to Olot, rural Catalonia, captured overnight where the answer is genuinely "nothing for
 * hours."
 */
const RURAL_NIGHT_GAP_RESPONSE: TransitousPlanResponse = {
	itineraries: [
		{
			duration: 2700,
			startTime: '2026-09-10T04:56:00Z',
			endTime: '2026-09-10T05:41:00Z',
			transfers: 0,
			legs: [
				{
					mode: 'WALK',
					duration: 420,
					startTime: '2026-09-10T04:56:00Z',
					endTime: '2026-09-10T05:03:00Z',
					distance: 323,
					from: { name: 'START', lat: 42.199, lon: 2.6975, tz: 'Europe/Madrid' },
					to: { name: 'Besalú', lat: 42.200294, lon: 2.697596, tz: 'Europe/Madrid' }
				},
				{
					mode: 'BUS',
					duration: 1980,
					startTime: '2026-09-10T05:03:00Z',
					endTime: '2026-09-10T05:36:00Z',
					routeShortName: 'L0163',
					routeLongName: 'Bus Transversal Garrotxa (Besalú-Castellfollit-Olot-Sant Esteve-les Planes)',
					headsign: "Sant Esteve d'en Bas",
					agencyName: 'Transports Elèctrics Interurbans, SA -TEISA-',
					from: { name: 'Besalú', lat: 42.200294, lon: 2.697596, tz: 'Europe/Madrid' },
					to: { name: "Olot (estació d'autobusos)", lat: 42.180717, lon: 2.491254, tz: 'Europe/Madrid' }
				},
				{
					mode: 'WALK',
					duration: 300,
					startTime: '2026-09-10T05:36:00Z',
					endTime: '2026-09-10T05:41:00Z',
					distance: 298,
					from: { name: "Olot (estació d'autobusos)", lat: 42.180717, lon: 2.491254, tz: 'Europe/Madrid' },
					to: { name: 'END', lat: 42.1818, lon: 2.4901, tz: 'Europe/Madrid' }
				}
			]
		},
		{
			duration: 2640,
			startTime: '2026-09-10T05:21:00Z',
			endTime: '2026-09-10T06:05:00Z',
			transfers: 0,
			legs: [
				{
					mode: 'WALK',
					duration: 420,
					startTime: '2026-09-10T05:21:00Z',
					endTime: '2026-09-10T05:28:00Z',
					distance: 323,
					from: { name: 'START', lat: 42.199, lon: 2.6975, tz: 'Europe/Madrid' },
					to: { name: 'Besalú', lat: 42.200294, lon: 2.697596, tz: 'Europe/Madrid' }
				},
				{
					mode: 'BUS',
					duration: 1920,
					startTime: '2026-09-10T05:28:00Z',
					endTime: '2026-09-10T06:00:00Z',
					routeShortName: 'L0326',
					routeLongName: '(e1) Olot - Girona i Girona - Banyoles - Olot',
					headsign: "Olot (estació d'autobusos)",
					agencyName: 'Transports Elèctrics Interurbans, SA -TEISA-',
					from: { name: 'Besalú', lat: 42.200294, lon: 2.697596, tz: 'Europe/Madrid' },
					to: { name: "Olot (estació d'autobusos)", lat: 42.180717, lon: 2.491254, tz: 'Europe/Madrid' }
				}
			]
		},
		{
			duration: 2520,
			startTime: '2026-09-10T05:38:00Z',
			endTime: '2026-09-10T06:20:00Z',
			transfers: 0,
			legs: [
				{
					mode: 'BUS',
					duration: 1800,
					startTime: '2026-09-10T05:45:00Z',
					endTime: '2026-09-10T06:15:00Z',
					routeShortName: 'L0803',
					routeLongName: 'Olot - Figueres',
					headsign: "Olot (estació d'autobusos)",
					agencyName: 'Transports Elèctrics Interurbans, SA -TEISA-',
					from: { name: 'Besalú', lat: 42.200294, lon: 2.697596, tz: 'Europe/Madrid' },
					to: { name: "Olot (estació d'autobusos)", lat: 42.180717, lon: 2.491254, tz: 'Europe/Madrid' }
				}
			]
		}
	]
};

/** Real response for two mid-Atlantic points with no transit coverage: HTTP 200, no
 * `error` field, just a genuinely empty `itineraries` array — distinct from a gap. */
const NO_ROUTE_RESPONSE: TransitousPlanResponse = { itineraries: [], direct: [] };

/** Issue #135: every lookup now states the journey moment it was planned for, so these
 * fixtures do too. `DEPART_AFTER` is the leg-starts-at-a-runway question ("I am free from
 * this moment"), `ARRIVE_BY` the leg-ends-at-a-gate one ("be there by this moment"). */
const DEPART_AFTER: TransitPlanMoment = {
	time: { local: '2026-09-10T11:00:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
	arriveBy: false
};
const ARRIVE_BY: TransitPlanMoment = {
	time: { local: '2026-09-10T12:00:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
	arriveBy: true
};

describe('mapPlanResponseToTransfer', () => {
	it('builds a transit Transfer from the earliest itinerary, with every leg described', () => {
		const transfer = mapPlanResponseToTransfer(DAYTIME_BARCELONA_RESPONSE, DEPART_AFTER);

		expect(transfer).toBeDefined();
		expect(transfer?.mode).toBe('transit');
		expect(transfer?.duration).toBe(52); // 3120s

		expect(transfer?.legs).toHaveLength(5);
		expect(transfer?.legs.map((leg) => leg.mode)).toEqual(['walk', 'transit', 'walk', 'transit', 'walk']);
		expect(transfer?.legs[0].description).toBe('Walk (38 m)');
		expect(transfer?.legs[1].description).toBe('Metro L1 to Hospital de Bellvitge (TMB)');
		expect(transfer?.legs[3].description).toBe('Bus 46 to Aeroport BCN (TMB)');

		// AGENTS.md "Timezones": local wall-clock time kept together with the offset, not
		// collapsed to a bare instant.
		expect(transfer?.legs[1].departure).toEqual({
			local: '2026-09-10T11:02:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
	});

	it('sets transitSchedule.intended to the first itinerary\'s first transit leg, not the overall walk start', () => {
		const transfer = mapPlanResponseToTransfer(DAYTIME_BARCELONA_RESPONSE, DEPART_AFTER);
		// The chosen itinerary starts with a 09:01 walk; the actual bus/metro service
		// question is about the 09:02 metro it connects to.
		expect(transfer?.transitSchedule?.intended.local).toBe('2026-09-10T11:02:00');
	});

	it('lists the following itineraries\' first transit departures, strictly after the intended one', () => {
		const transfer = mapPlanResponseToTransfer(DAYTIME_BARCELONA_RESPONSE, DEPART_AFTER);
		const following = transfer?.transitSchedule?.following ?? [];
		expect(following.map((d) => d.local)).toEqual([
			'2026-09-10T11:06:00', // second itinerary's metro
			'2026-09-10T11:18:00' // third itinerary's bus
		]);
	});

	it('the last-bus problem: reports the real gap instead of hiding it or erroring', () => {
		// This is the acceptance criterion: a 01:00Z ask met with a 05:03Z bus is a
		// first-class result, not an error and not an empty array.
		const transfer = mapPlanResponseToTransfer(RURAL_NIGHT_GAP_RESPONSE, DEPART_AFTER);

		expect(transfer).toBeDefined();
		expect(transfer?.mode).toBe('transit');
		expect(transfer?.transitSchedule?.intended).toEqual({
			local: '2026-09-10T07:03:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
		// A caller diffing this against its own requested 03:00 local departure gets a
		// 4h03m gap — exactly the "no service for 4h 15m, first departure 05:20" shape the
		// brief asks for, computed by the caller from data this function never discards.
		expect(transfer?.transitSchedule?.following.map((d) => d.local)).toEqual([
			'2026-09-10T07:28:00',
			'2026-09-10T07:45:00'
		]);
	});

	it('returns undefined (not a thrown error) when there is no transit route at all', () => {
		expect(mapPlanResponseToTransfer(NO_ROUTE_RESPONSE, DEPART_AFTER)).toBeUndefined();
	});

	it('returns undefined when the response has no itineraries field at all', () => {
		expect(mapPlanResponseToTransfer({}, DEPART_AFTER)).toBeUndefined();
	});

	it('falls back to a generic "Transit" label for an unrecognised leg mode', () => {
		const response: TransitousPlanResponse = {
			itineraries: [
				{
					duration: 600,
					startTime: '2026-09-10T09:00:00Z',
					endTime: '2026-09-10T09:10:00Z',
					transfers: 0,
					legs: [
						{
							mode: 'MONORAIL',
							duration: 600,
							startTime: '2026-09-10T09:00:00Z',
							endTime: '2026-09-10T09:10:00Z',
							from: { name: 'A', lat: 0, lon: 0, tz: 'UTC' },
							to: { name: 'B', lat: 0, lon: 0, tz: 'UTC' }
						}
					]
				}
			]
		};
		const transfer = mapPlanResponseToTransfer(response, DEPART_AFTER);
		expect(transfer?.legs[0].description).toBe('Transit');
	});

	it('falls back to UTC when a place is missing its timezone', () => {
		const response: TransitousPlanResponse = {
			itineraries: [
				{
					duration: 600,
					startTime: '2026-09-10T09:00:00Z',
					endTime: '2026-09-10T09:10:00Z',
					transfers: 0,
					legs: [
						{
							mode: 'BUS',
							duration: 600,
							startTime: '2026-09-10T09:00:00Z',
							endTime: '2026-09-10T09:10:00Z',
							from: { name: 'A', lat: 0, lon: 0 },
							to: { name: 'B', lat: 0, lon: 0 }
						}
					]
				}
			]
		};
		const transfer = mapPlanResponseToTransfer(response, DEPART_AFTER);
		expect(transfer?.transitSchedule?.intended.timeZone).toBe('UTC');
	});
});

/**
 * Issue #68: `transitous-client.ts`'s own shape check only confirms `itineraries` is an
 * array — nothing validates a leg's `startTime`/`duration`/coordinates before this file
 * feeds them to `utcInstantToLocalDateTime`, which throws on an Invalid Date. These cases
 * corrupt one field of the real DAYTIME_BARCELONA_RESPONSE fixture per case, following the
 * "drop the bad item, keep the rest" rule this adapter can follow because a real captured
 * fixture exists here — unlike Kiwi's.
 */
describe('runtime validation of an unverified field type (corrupted fixture)', () => {
	it('drops one corrupted itinerary and falls through to the next good one', () => {
		const response: TransitousPlanResponse = {
			itineraries: [
				{
					duration: 3120,
					startTime: 'not-a-real-instant',
					endTime: '2026-09-10T09:53:00Z',
					transfers: 1,
					legs: [
						{
							mode: 'BUS',
							duration: 3120,
							startTime: 'not-a-real-instant',
							endTime: '2026-09-10T09:53:00Z',
							from: { name: 'A', lat: 41.38, lon: 2.16, tz: 'Europe/Madrid' },
							to: { name: 'B', lat: 41.3, lon: 2.07, tz: 'Europe/Madrid' }
						}
					]
				},
				{
					duration: 600,
					startTime: '2026-09-10T10:00:00Z',
					endTime: '2026-09-10T10:10:00Z',
					transfers: 0,
					legs: [
						{
							mode: 'BUS',
							duration: 600,
							startTime: '2026-09-10T10:00:00Z',
							endTime: '2026-09-10T10:10:00Z',
							from: { name: 'A', lat: 41.38, lon: 2.16, tz: 'Europe/Madrid' },
							to: { name: 'B', lat: 41.3, lon: 2.07, tz: 'Europe/Madrid' }
						}
					]
				}
			]
		};
		expect(() => mapPlanResponseToTransfer(response, DEPART_AFTER)).not.toThrow();
		const transfer = mapPlanResponseToTransfer(response, DEPART_AFTER);
		expect(transfer?.transitSchedule?.intended.local).toBe('2026-09-10T12:00:00');
	});

	it('throws TransitousMapMalformedResponseError when every itinerary is unreadable, not "no route"', () => {
		const response: TransitousPlanResponse = {
			itineraries: [
				{
					duration: 3120,
					startTime: 'garbage',
					endTime: 'garbage',
					transfers: 1,
					legs: [
						{
							mode: 'BUS',
							duration: 3120,
							startTime: 'garbage',
							endTime: 'garbage',
							from: { name: 'A', lat: 41.38, lon: 2.16 },
							to: { name: 'B', lat: 41.3, lon: 2.07 }
						}
					]
				}
			]
		};
		expect(() => mapPlanResponseToTransfer(response, DEPART_AFTER)).toThrow(TransitousMapMalformedResponseError);
	});

	it('returns undefined (not malformed) for a genuinely empty itineraries array — the ordinary no-service case', () => {
		expect(mapPlanResponseToTransfer({ itineraries: [] }, DEPART_AFTER)).toBeUndefined();
	});

	it('drops a leg whose duration is a non-numeric string, failing that itinerary rather than producing NaN', () => {
		const response: TransitousPlanResponse = {
			itineraries: [
				{
					duration: 600,
					startTime: '2026-09-10T09:00:00Z',
					endTime: '2026-09-10T09:10:00Z',
					transfers: 0,
					legs: [
						{
							mode: 'BUS',
							duration: 'ten minutes' as unknown as number,
							startTime: '2026-09-10T09:00:00Z',
							endTime: '2026-09-10T09:10:00Z',
							from: { name: 'A', lat: 0, lon: 0 },
							to: { name: 'B', lat: 0, lon: 0 }
						}
					]
				}
			]
		};
		expect(() => mapPlanResponseToTransfer(response, DEPART_AFTER)).toThrow(TransitousMapMalformedResponseError);
	});

	it('drops a leg whose place has a non-numeric latitude rather than corrupting timezone maths', () => {
		const response: TransitousPlanResponse = {
			itineraries: [
				{
					duration: 600,
					startTime: '2026-09-10T09:00:00Z',
					endTime: '2026-09-10T09:10:00Z',
					transfers: 0,
					legs: [
						{
							mode: 'BUS',
							duration: 600,
							startTime: '2026-09-10T09:00:00Z',
							endTime: '2026-09-10T09:10:00Z',
							from: { name: 'A', lat: '0' as unknown as number, lon: 0 },
							to: { name: 'B', lat: 0, lon: 0 }
						}
					]
				}
			]
		};
		expect(() => mapPlanResponseToTransfer(response, DEPART_AFTER)).toThrow(TransitousMapMalformedResponseError);
	});
});
