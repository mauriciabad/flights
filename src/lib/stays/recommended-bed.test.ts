import type { Airport, Coordinates, Property, RoomKind, Stay } from '$lib/domain';
import { makeItinerary } from '$lib/results/test-support';
import { describe, expect, it } from 'vitest';
import type { StopoverForRanking } from './rank';
import { rankProperties } from './rank';
import { firstBookableStay, recommendedStay, stopoverForRanking } from './recommended-bed';
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

describe('stopoverForRanking', () => {
	const airport: Airport = {
		iataCode: 'VIE',
		name: 'Vienna Airport',
		coordinates: AIRPORT,
		city: { name: 'Vienna', coordinates: CITY_CENTRE, country: { isoCode: 'AT', name: 'Austria' } },
		country: { isoCode: 'AT', name: 'Austria' },
		sizeClass: 'large'
	};

	it('measures from the runway and names the city centre separately', () => {
		const stopover = stopoverForRanking(makeItinerary({ nightsInConnection: 2 }), airport, 3, 1);
		expect(stopover.connectionAirport).toBe(AIRPORT);
		expect(stopover.cityCentre).toBe(CITY_CENTRE);
		expect(stopover.nights).toBe(2);
		expect(stopover.travellers).toBe(3);
		expect(stopover.females).toBe(1);
	});

	it('counts no day out for a stopover whose free time is a night between two flights', () => {
		const overnight = makeItinerary({
			nightsInConnection: 1,
			freeTimeStart: '2026-10-14T22:00:00',
			freeTimeEnd: '2026-10-15T06:00:00'
		});
		expect(stopoverForRanking(overnight, airport).visitDays).toBe(0);
	});

	it('counts the days a longer stopover actually gives the traveller', () => {
		const twoDays = makeItinerary({
			nightsInConnection: 2,
			freeTimeStart: '2026-10-14T09:00:00',
			freeTimeEnd: '2026-10-16T20:00:00'
		});
		expect(stopoverForRanking(twoDays, airport).visitDays).toBeGreaterThan(1);
	});

	it('leaves the centre out for an airport with no city point to offer', () => {
		const noCentre: Airport = { ...airport, city: { ...airport.city, coordinates: undefined } };
		expect(stopoverForRanking(makeItinerary({}), noCentre).cityCentre).toBeUndefined();
	});
});
