import type { Coordinates, Duration, Property, RoomKind, Stay } from '$lib/domain';
import type { StopoverForRanking } from '$lib/stays';
import { describe, expect, it } from 'vitest';
import { makeItinerary } from './test-support';
import {
	bedForLength,
	reapplyWaitingTimes,
	recordChoice,
	recordStaySwap
} from './traveller-choices';

const AIRPORT: Coordinates = { latitude: 48.11, longitude: 16.57 };

function kmFromAirport(km: number): Coordinates {
	return { latitude: AIRPORT.latitude + km / 111.19, longitude: AIRPORT.longitude };
}

const CITY_CENTRE = kmFromAirport(40.1);

function makeStay(
	name: string,
	coordinates: Coordinates,
	roomKind: RoomKind,
	minorUnits: number
): Stay {
	const property: Property = { name, coordinates, images: [] };
	return { property, roomKind, pricePerNight: { minorUnits, currency: 'EUR' } };
}

const TERMINAL_ROOM = makeStay('Runway Inn', AIRPORT, 'private', 6000);
const TOWN_DORM = makeStay('Old Town Hostel', CITY_CENTRE, 'dorm', 1500);
const CANDIDATES = [TERMINAL_ROOM, TOWN_DORM];

function stopover(nights: number, visitDays: number): StopoverForRanking {
	return {
		travellers: 2,
		females: undefined,
		connectionAirport: AIRPORT,
		cityCentre: CITY_CENTRE,
		nights,
		visitDays
	};
}

describe('recordChoice', () => {
	it('keeps decisions about other results untouched', () => {
		const before = { LGW: { nights: 2 } };
		expect(recordChoice(before, 'VIE', { nights: 3 })).toEqual({
			LGW: { nights: 2 },
			VIE: { nights: 3 }
		});
	});

	it('merges a second decision into the same result rather than replacing it', () => {
		const withNights = recordChoice({}, 'LGW', { nights: 2 });
		expect(recordChoice(withNights, 'LGW', { stay: TOWN_DORM })).toEqual({
			LGW: { nights: 2, stay: TOWN_DORM }
		});
	});

	it('forgets a field handed back as undefined, which is how a bed stops being pinned', () => {
		const pinned = recordChoice({ LGW: { nights: 2 } }, 'LGW', { stay: TOWN_DORM });
		const unpinned = recordChoice(pinned, 'LGW', { stay: undefined });
		expect(unpinned.LGW).toEqual({ nights: 2 });
		expect('stay' in unpinned.LGW).toBe(false);
	});

	it('drops a result that has no decisions left', () => {
		const pinned = recordChoice({}, 'LGW', { stay: TOWN_DORM });
		expect(recordChoice(pinned, 'LGW', { stay: undefined })).toEqual({});
	});

	it('does not mutate the record it was given', () => {
		const before = { LGW: { nights: 2 } };
		recordChoice(before, 'LGW', { stay: TOWN_DORM, connectionWaitingTime: 90 as Duration });
		expect(before).toEqual({ LGW: { nights: 2 } });
	});
});

describe('bedForLength', () => {
	it('re-optimises a recommended bed when the new length changes the answer', () => {
		const result = bedForLength({
			previous: TERMINAL_ROOM,
			chosen: undefined,
			candidates: CANDIDATES,
			stopover: stopover(4, 3)
		});
		expect(result.stay).toBe(TOWN_DORM);
		expect(result.swap).toEqual({ from: TERMINAL_ROOM, to: TOWN_DORM, nights: 4 });
	});

	it('leaves the traveller their own bed at a length that would have moved a recommended one', () => {
		const result = bedForLength({
			previous: TERMINAL_ROOM,
			chosen: TERMINAL_ROOM,
			candidates: CANDIDATES,
			stopover: stopover(4, 3)
		});
		expect(result.stay).toBe(TERMINAL_ROOM);
		expect(result.swap).toBeUndefined();
	});

	it('carries the bed the traveller chose even when it left the candidate list', () => {
		const gone = makeStay('Closed Hostel', kmFromAirport(9), 'dorm', 1200);
		const result = bedForLength({
			previous: TERMINAL_ROOM,
			chosen: gone,
			candidates: CANDIDATES,
			stopover: stopover(4, 3)
		});
		expect(result.stay).toBe(gone);
	});

	it('announces nothing when the recommendation holds at the new length', () => {
		const result = bedForLength({
			previous: TERMINAL_ROOM,
			chosen: undefined,
			candidates: CANDIDATES,
			stopover: stopover(1, 0)
		});
		expect(result.stay).toBe(TERMINAL_ROOM);
		expect(result.swap).toBeUndefined();
	});

	it('announces nothing when only the room changes at the property already booked', () => {
		const dorm = makeStay('Runway Inn', AIRPORT, 'dorm', 2200);
		const result = bedForLength({
			previous: TERMINAL_ROOM,
			chosen: undefined,
			candidates: [TERMINAL_ROOM, dorm],
			stopover: stopover(1, 0)
		});
		expect(result.stay).toBe(dorm);
		expect(result.swap).toBeUndefined();
	});

	it('announces nothing when the stopover had no bed to move', () => {
		const result = bedForLength({
			previous: undefined,
			chosen: undefined,
			candidates: CANDIDATES,
			stopover: stopover(4, 3)
		});
		expect(result.stay).toBe(TOWN_DORM);
		expect(result.swap).toBeUndefined();
	});

	it('has no bed and no swap when no provider returned anything', () => {
		const result = bedForLength({
			previous: TERMINAL_ROOM,
			chosen: undefined,
			candidates: [],
			stopover: stopover(4, 3)
		});
		expect(result.stay).toBeUndefined();
		expect(result.swap).toBeUndefined();
	});
});

describe('recordStaySwap', () => {
	const swap = { from: TERMINAL_ROOM, to: TOWN_DORM, nights: 3 };

	it('holds one swap per result, without disturbing the others', () => {
		const held = recordStaySwap({ VIE: swap }, 'LGW', swap);
		expect(Object.keys(held).sort()).toEqual(['LGW', 'VIE']);
	});

	it('forgets the swap when the traveller has answered it', () => {
		expect(recordStaySwap({ LGW: swap }, 'LGW', undefined)).toEqual({});
	});
});

describe('reapplyWaitingTimes', () => {
	it('puts a buffer the traveller typed back on a trip that was rebuilt without it', () => {
		const rebuilt = makeItinerary({ nightsInConnection: 2 });
		const withBuffer = reapplyWaitingTimes(rebuilt, { connectionWaitingTime: 240 as Duration });
		expect(withBuffer.connectionWaitingTime).toBe(240);
	});

	it('clamps the connection buffer to the free time the new pairing has to give', () => {
		// The fixture waits 120 minutes and has 300 free, so 420 is the whole layover and a
		// buffer pinned on a longer stopover cannot exceed it. What free time is left is
		// `deriveItinerary`'s answer, not this function's, and this fixture's window is not
		// the 300 minutes it declares.
		const rebuilt = makeItinerary({ nightsInConnection: 0, freeTimeMinutes: 300 });
		const withBuffer = reapplyWaitingTimes(rebuilt, { connectionWaitingTime: 600 as Duration });
		expect(withBuffer.connectionWaitingTime).toBe(420);
	});

	it('leaves the origin buffer unclamped, since it never borrows from free time', () => {
		const rebuilt = makeItinerary({});
		expect(reapplyWaitingTimes(rebuilt, { originWaitingTime: 600 as Duration }).originWaitingTime).toBe(600);
	});

	it('hands back the same trip when the traveller has typed no buffer at all', () => {
		const rebuilt = makeItinerary({ nightsInConnection: 1 });
		expect(reapplyWaitingTimes(rebuilt, { nights: 1 })).toBe(rebuilt);
	});
});
