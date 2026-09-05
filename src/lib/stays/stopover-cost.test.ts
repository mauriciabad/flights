import { describe, expect, it } from 'vitest';
import type { Coordinates, Stay } from '$lib/domain';
import { reachCostMinorUnits, stopoverStayCostMinorUnits } from './stopover-cost';

const AIRPORT: Coordinates = { latitude: 51.1537, longitude: -0.1821 };

/** A point `km` due north of the airport. One degree of latitude is 111.19 km on the
 * Earth radius `distance.ts` uses. */
function kmAway(km: number): Coordinates {
	return { latitude: AIRPORT.latitude + km / 111.19, longitude: AIRPORT.longitude };
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
	it('charges the room per night and the journey exactly twice', () => {
		const bed = stayAt(10, 2000);
		expect(stopoverStayCostMinorUnits(bed, AIRPORT, 1)).toBe(2000 + 3400);
		expect(stopoverStayCostMinorUnits(bed, AIRPORT, 3)).toBe(6000 + 3400);
	});

	it('prices a nightless stopover on the journey alone rather than going negative', () => {
		expect(stopoverStayCostMinorUnits(stayAt(10, 2000), AIRPORT, 0)).toBe(3400);
		expect(stopoverStayCostMinorUnits(stayAt(10, 2000), AIRPORT, -2)).toBe(3400);
	});

	it('crosses over from the near room to the far dorm as the nights add up', () => {
		// Both figures measured off the owner's Gatwick card on issue #219.
		const nearRoom = stayAt(2.8, 5282);
		const farDorm = stayAt(48.3, 1300);
		const cheaper = (nights: number) =>
			stopoverStayCostMinorUnits(nearRoom, AIRPORT, nights) <
			stopoverStayCostMinorUnits(farDorm, AIRPORT, nights)
				? 'near'
				: 'far';

		expect(cheaper(1)).toBe('near');
		expect(cheaper(3)).toBe('near');
		expect(cheaper(4)).toBe('far');
	});
});
