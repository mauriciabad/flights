import type { Coordinates, Property, RoomKind, Stay } from '$lib/domain';
import { describe, expect, it } from 'vitest';
import type { StopoverForRanking } from './rank';
import { rankProperties } from './rank';
import { firstBookableStay, recommendedStay } from './recommended-bed';
import { groupByProperty } from './types';

const AIRPORT: Coordinates = { latitude: 48.11, longitude: 16.57 };

/** One degree of latitude is 111.19 km on `distance.ts`' Earth radius, so a case can name
 * a distance instead of a coordinate. */
function kmFromAirport(km: number): Coordinates {
	return { latitude: AIRPORT.latitude + km / 111.19, longitude: AIRPORT.longitude };
}

/** `search/resources.ts`' measured Gatwick-to-central-London figure, which is the geometry
 * the crossover cases below stand on. */
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

function stopover(nights: number, visitDays: number, females?: number): StopoverForRanking {
	return {
		travellers: 2,
		females,
		connectionAirport: AIRPORT,
		cityCentre: CITY_CENTRE,
		nights,
		visitDays
	};
}

describe('recommendedStay', () => {
	it('prefers the dearer room beside the terminal for a single night with nothing to do', () => {
		expect(recommendedStay([TOWN_DORM, TERMINAL_ROOM], stopover(1, 0))).toBe(TERMINAL_ROOM);
	});

	it('moves to the cheap bed across town once there are enough nights to pay for the ride', () => {
		expect(recommendedStay([TOWN_DORM, TERMINAL_ROOM], stopover(4, 0))).toBe(TOWN_DORM);
	});

	it('moves to the bed by the centre on days out alone, without adding a night', () => {
		expect(recommendedStay([TOWN_DORM, TERMINAL_ROOM], stopover(1, 2))).toBe(TOWN_DORM);
	});

	it('walks past a property whose only room this group cannot book', () => {
		const womenOnly = makeStay('Sorority Hostel', AIRPORT, 'female-dorm', 900);
		expect(recommendedStay([womenOnly, TERMINAL_ROOM], stopover(1, 0, 0))).toBe(TERMINAL_ROOM);
	});

	it('has no answer when every room on offer is one this group cannot book', () => {
		const womenOnly = makeStay('Sorority Hostel', AIRPORT, 'female-dorm', 900);
		const alsoWomenOnly = makeStay('Another Womens Hostel', CITY_CENTRE, 'female-dorm', 1100);
		expect(recommendedStay([womenOnly, alsoWomenOnly], stopover(2, 1, 0))).toBeUndefined();
	});

	it('has no answer when no provider returned anything', () => {
		expect(recommendedStay([], stopover(2, 1))).toBeUndefined();
	});

	it('picks the cheapest room the group can book at the property it recommends', () => {
		const dorm = makeStay('Runway Inn', AIRPORT, 'dorm', 2200);
		expect(recommendedStay([TERMINAL_ROOM, dorm], stopover(1, 0))).toBe(dorm);
	});
});

describe('firstBookableStay', () => {
	// The guarantee this module exists for: the picker draws its list from `rankProperties`
	// and reads its head from here, while the page ranks from scratch. Two answers that can
	// differ is an announcement of a swap the list on screen disagrees with.
	it('agrees with recommendedStay on the same candidates', () => {
		const candidates = [TOWN_DORM, TERMINAL_ROOM];
		for (const nights of [1, 2, 3, 4, 5]) {
			const stay = stopover(nights, nights - 1);
			const ranked = rankProperties(groupByProperty(candidates), stay);
			expect(firstBookableStay(ranked, stay.travellers, stay.females)).toBe(
				recommendedStay(candidates, stay)
			);
		}
	});
});
