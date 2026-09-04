/**
 * Issue #220: the two rules that stand between MOTIS's answer and a card claiming the
 * traveller can get across Birmingham in 33 hours by way of Sardinia.
 *
 * `transitous-plan-bhx-air-legs.json` is a real `/api/v1/plan` response, captured on
 * 2026-09-05 for the owner's own pair, Birmingham airport (52.453899,-1.74803) to
 * Birmingham Central Backpackers (52.4763977,-1.8859854), 9.7 km apart, asked at
 * 2026-10-07T02:00:00Z. Trimmed to the fields this adapter reads (routing geometry,
 * turn-by-turn walking steps and the `debugOutput` block removed), nothing else changed.
 * Both itineraries in it fly out of Birmingham to Olbia, Rome, Cagliari and Amsterdam and
 * come back by train and coach through Den Haag and London Victoria.
 *
 * Two facts worth keeping next to it, both measured the same day against the live API:
 * asked the same question at 06:00, 13:00 and 23:30 the same server answers with an empty
 * `itineraries` array, and asked with `AIRPLANE` left out of `transitModes` it answers with
 * an empty array at 02:00 too. There is no ground public transport in Transitous's data
 * between these two points at all. Nothing is being taken away from the traveller here.
 */

import { describe, expect, it } from 'vitest';
import type { TransitPlanMoment } from '../../domain';
import { greatCircleDistanceKm, maxPlausibleTransitMinutes } from '../../domain';
import { mapPlanResponseToTransfer } from './transitous-mapper';
import type { TransitousItinerary, TransitousPlanResponse } from './transitous-types';
import airLegsFixture from './fixtures/transitous-plan-bhx-air-legs.json';

const BHX = { latitude: 52.453899, longitude: -1.74803 };
const HOSTEL = { latitude: 52.4763977, longitude: -1.8859854 };
const BHX_TO_HOSTEL_KM = greatCircleDistanceKm(BHX, HOSTEL);

const RECORDED = airLegsFixture as TransitousPlanResponse;

const FREE_FROM_0400: TransitPlanMoment = {
	time: { local: '2026-10-11T04:00:00', timeZone: 'Europe/London', utcOffsetMinutes: 60 },
	arriveBy: false
};

/** A perfectly ordinary Birmingham bus, constructed rather than captured because Transitous
 * has none to capture. Times, distance and duration are the shape a National Express West
 * Midlands run across those 9.7 km would take. */
function busItinerary(startUtc: string, endUtc: string, seconds: number): TransitousItinerary {
	return {
		duration: seconds,
		startTime: startUtc,
		endTime: endUtc,
		transfers: 0,
		legs: [
			{
				mode: 'BUS',
				duration: seconds,
				startTime: startUtc,
				endTime: endUtc,
				routeShortName: '900',
				headsign: 'Birmingham City Centre',
				agencyName: 'National Express West Midlands',
				from: { name: 'Birmingham Airport', lat: 52.453899, lon: -1.74803, tz: 'Europe/London' },
				to: { name: 'Moor Street Queensway', lat: 52.4764, lon: -1.886, tz: 'Europe/London' }
			}
		]
	};
}

describe('the recorded Birmingham response (issue #220)', () => {
	it('is the journey the owner was actually offered: flights, 21h 27m and up, to go 9.7 km', () => {
		// Guards the fixture itself. If a later edit trims the air legs out of it, every
		// assertion below would pass for the wrong reason.
		expect(BHX_TO_HOSTEL_KM).toBeCloseTo(9.7, 1);
		expect(RECORDED.itineraries).toHaveLength(2);
		for (const itinerary of RECORDED.itineraries ?? []) {
			expect(itinerary.legs.some((leg) => leg.mode === 'AIRPLANE')).toBe(true);
			expect(itinerary.duration / 3600).toBeGreaterThan(21);
		}
		expect(RECORDED.itineraries?.[0].legs.map((leg) => leg.agencyName)).toContain('JET TWO COM');
	});

	it('produces no transfer at all, rather than a flight labelled "Public transport"', () => {
		expect(mapPlanResponseToTransfer(RECORDED, FREE_FROM_0400, BHX_TO_HOSTEL_KM)).toBeUndefined();
	});

	it('drops it for containing a flight, not merely for being long', () => {
		// The same itineraries at a distance where 22 hours would clear the duration bound.
		// A flight is never a ground transfer, however far apart the two points are.
		expect(mapPlanResponseToTransfer(RECORDED, FREE_FROM_0400, 5000)).toBeUndefined();
	});
});

describe('an air itinerary next to a real one', () => {
	it('never wins on departure time, which is how it reached the card in the first place', () => {
		// The recorded flight boards at 03:05Z; the bus is half an hour behind it. Ordered
		// by departure alone, which is what this mapper did before #220, the flight wins.
		const mixed: TransitousPlanResponse = {
			itineraries: [
				...(RECORDED.itineraries ?? []),
				busItinerary('2026-10-11T03:35:00Z', '2026-10-11T04:12:00Z', 2220)
			]
		};

		const transfer = mapPlanResponseToTransfer(mixed, FREE_FROM_0400, BHX_TO_HOSTEL_KM);

		expect(transfer?.duration).toBe(37);
		expect(transfer?.legs.map((leg) => leg.description)).toEqual([
			'Bus 900 to Birmingham City Centre (National Express West Midlands)'
		]);
		// And no flight departure is offered as "the next one" either.
		expect(transfer?.transitSchedule?.following).toEqual([]);
	});

	it('lets a slow ground answer win over a quick one it must not offer', () => {
		const mixed: TransitousPlanResponse = {
			itineraries: [
				...(RECORDED.itineraries ?? []),
				busItinerary('2026-10-11T05:00:00Z', '2026-10-11T06:20:00Z', 4800)
			]
		};

		const transfer = mapPlanResponseToTransfer(mixed, FREE_FROM_0400, BHX_TO_HOSTEL_KM);
		expect(transfer?.duration).toBe(80);
	});
});

describe('a ground itinerary that is simply too long for the distance', () => {
	const absurdlySlow: TransitousPlanResponse = {
		itineraries: [busItinerary('2026-10-11T04:10:00Z', '2026-10-11T11:10:00Z', 25200)]
	};

	it('loses to any plausible sibling, even one departing later', () => {
		const response: TransitousPlanResponse = {
			itineraries: [
				...(absurdlySlow.itineraries ?? []),
				busItinerary('2026-10-11T04:40:00Z', '2026-10-11T05:17:00Z', 2220)
			]
		};

		const transfer = mapPlanResponseToTransfer(response, FREE_FROM_0400, BHX_TO_HOSTEL_KM);
		expect(transfer?.duration).toBe(37);
		// The seven-hour option is not offered as a fallback departure either.
		expect(transfer?.transitSchedule?.following).toEqual([]);
	});

	it('still comes back when it is the only answer, so the app can say what it refused', () => {
		// Deliberately NOT dropped here. `search/resources.ts` is the single place that
		// refuses a transfer for its duration, and it can only tell a traveller "a route
		// came back and it was 7 hours" if the route reaches it. An adapter returning
		// nothing would leave the card claiming there is no service between these points,
		// which is a different fact and not the one observed.
		const transfer = mapPlanResponseToTransfer(absurdlySlow, FREE_FROM_0400, BHX_TO_HOSTEL_KM);
		expect(transfer?.duration).toBe(420);
		expect(transfer?.duration).toBeGreaterThan(maxPlausibleTransitMinutes(BHX_TO_HOSTEL_KM));
	});
});

describe('maxPlausibleTransitMinutes', () => {
	it('allows 2h 28m for the 9.7 km in issue #220, and refuses the 21h 27m answer', () => {
		expect(maxPlausibleTransitMinutes(BHX_TO_HOSTEL_KM)).toBeCloseTo(148, 0);
		expect(1287).toBeGreaterThan(maxPlausibleTransitMinutes(BHX_TO_HOSTEL_KM));
	});

	it('leaves every real answer measured against it alone', () => {
		// Barcelona airport to Plaça Catalunya, 12.6 km: six live itineraries on 2026-09-05,
		// the slowest 62 minutes. Stansted to central London, 48.9 km: the Stansted Express
		// is about an hour, and a bus-and-tube combination well under three.
		expect(maxPlausibleTransitMinutes(12.6)).toBeGreaterThan(62);
		expect(maxPlausibleTransitMinutes(48.9)).toBeGreaterThan(180);
	});

	it('scales with distance instead of capping flat, which is the whole point', () => {
		// A 90-minute transfer is ordinary across a big city and absurd across a small one,
		// so the same number cannot be right for both.
		expect(maxPlausibleTransitMinutes(0)).toBe(90);
		expect(maxPlausibleTransitMinutes(30)).toBe(270);
		expect(maxPlausibleTransitMinutes(60)).toBe(450);
	});

	it('does not go negative or blow up on a degenerate distance', () => {
		expect(maxPlausibleTransitMinutes(-5)).toBe(90);
	});
});
