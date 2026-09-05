import { describe, expect, it } from 'vitest';
import type { Coordinates, Stay } from '$lib/domain';
import type { StopoverJourneys } from './stopover-cost';
import { reachCostMinorUnits, stopoverStayCostMinorUnits } from './stopover-cost';

const AIRPORT: Coordinates = { latitude: 51.1537, longitude: -0.1821 };

/** A point `km` due north of the airport. One degree of latitude is 111.19 km on the
 * Earth radius `distance.ts` uses. Every point in this file is built this way, so it sits
 * on the airport's own meridian and the distance between two of them is the difference of
 * the kilometres they were built from. */
function kmAway(km: number): Coordinates {
	return { latitude: AIRPORT.latitude + km / 111.19, longitude: AIRPORT.longitude };
}

/** A stopover with no city point unless a case is about the days out, since that is the
 * shape `search/resources.ts` ranks with. */
function journeys(nights: number, visitDays = 0, cityCentre?: Coordinates): StopoverJourneys {
	return { connectionAirport: AIRPORT, cityCentre, nights, visitDays };
}

function stayAt(km: number, minorUnits: number, currency = 'EUR'): Stay {
	return {
		property: { name: `${km} km out`, coordinates: kmAway(km), images: [] },
		roomKind: 'dorm',
		pricePerNight: { minorUnits, currency }
	};
}

describe('reachCostMinorUnits', () => {
	it('charges a base each way plus the distance, both directions', () => {
		// 3 a leg before it moves, then 1.40 a kilometre: 2 x (3 + 14) = 34.
		expect(reachCostMinorUnits(kmAway(10), AIRPORT, 'EUR')).toBe(3400);
	});

	it('costs almost nothing next door and a great deal across a city', () => {
		expect(reachCostMinorUnits(kmAway(0), AIRPORT, 'EUR')).toBe(600);
		// The Gatwick card on issue #219: a bed 48.3 km out, about 141 to reach and return.
		expect(reachCostMinorUnits(kmAway(48.3), AIRPORT, 'EUR')).toBe(14125);
	});

	it('scales to the currency, not to a hardcoded two decimal places', () => {
		// Yen has no minor unit, so the same ride is 34 rather than 3400 (issue #179's rule).
		expect(reachCostMinorUnits(kmAway(10), AIRPORT, 'JPY')).toBe(34);
	});
});

describe('stopoverStayCostMinorUnits', () => {
	it('charges the room per night and the airport journey exactly twice', () => {
		const bed = stayAt(10, 2000);
		expect(stopoverStayCostMinorUnits(bed, journeys(1))).toBe(2000 + 3400);
		expect(stopoverStayCostMinorUnits(bed, journeys(3))).toBe(6000 + 3400);
	});

	it('prices a nightless stopover on the journey alone rather than going negative', () => {
		expect(stopoverStayCostMinorUnits(stayAt(10, 2000), journeys(0))).toBe(3400);
		expect(stopoverStayCostMinorUnits(stayAt(10, 2000), journeys(-2))).toBe(3400);
	});

	it('crosses over from the near room to the far dorm as the nights add up', () => {
		// Both figures measured off the owner's Gatwick card on issue #219.
		const nearRoom = stayAt(2.8, 5282);
		const farDorm = stayAt(48.3, 1300);
		const cheaper = (nights: number) =>
			stopoverStayCostMinorUnits(nearRoom, journeys(nights)) <
			stopoverStayCostMinorUnits(farDorm, journeys(nights))
				? 'near'
				: 'far';

		expect(cheaper(1)).toBe('near');
		expect(cheaper(3)).toBe('near');
		expect(cheaper(4)).toBe('far');
	});

	it('charges one round trip into the centre per day the traveller can use it', () => {
		// The bed is 10 km from the airport and the centre 10 km beyond the bed, so each
		// day out is the same 34 the airport legs cost.
		const bed = stayAt(10, 2000);
		const centre = kmAway(20);
		expect(stopoverStayCostMinorUnits(bed, journeys(1, 1, centre))).toBe(2000 + 3400 + 3400);
		expect(stopoverStayCostMinorUnits(bed, journeys(1, 2, centre))).toBe(2000 + 3400 + 6800);
	});

	it('adds nothing at all for a centre the traveller has no day to spend in', () => {
		// A stopover that is one night's sleep between two flights pays for the two airport
		// legs and no more, whatever the bed's distance from town.
		const bed = stayAt(10, 2000);
		expect(stopoverStayCostMinorUnits(bed, journeys(1, 0, kmAway(20)))).toBe(2000 + 3400);
		expect(stopoverStayCostMinorUnits(bed, journeys(1, -3, kmAway(20)))).toBe(2000 + 3400);
	});

	it('adds nothing for an airport with no city point, however many days are free', () => {
		// `City.coordinates` is absent for most airports and `domain/airport.ts` refuses to
		// substitute the runway for it, so the centre term stays silent rather than guessing.
		const bed = stayAt(10, 2000);
		for (const visitDays of [0, 1, 7]) {
			expect(stopoverStayCostMinorUnits(bed, journeys(1, visitDays))).toBe(2000 + 3400);
		}
	});

	it('hands the list to the bed near the centre once there are days to spend there', () => {
		// The same two Gatwick beds, with central London 40.1 km from the terminal, which is
		// `search/resources.ts`' own measurement. That puts the Horley room 37.3 km from the
		// centre and the London dorm 8.2 km from it.
		const nearTerminal = stayAt(2.8, 5282);
		const nearCentre = stayAt(48.3, 1300);
		const centre = kmAway(40.1);
		const cheaper = (visitDays: number) =>
			stopoverStayCostMinorUnits(nearTerminal, journeys(1, visitDays, centre)) <
			stopoverStayCostMinorUnits(nearCentre, journeys(1, visitDays, centre))
				? 'terminal'
				: 'centre';

		// One night and no day out is 5282 + 1384 against 1300 + 14125, the nights rule at work.
		expect(cheaper(0)).toBe('terminal');
		// One day out adds 11044 to the Horley room and 2896 to the dorm, not enough yet.
		expect(cheaper(1)).toBe('terminal');
		// The second day settles it, 28754 against 21217.
		expect(cheaper(2)).toBe('centre');
	});
});
