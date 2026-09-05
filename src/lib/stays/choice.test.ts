import type { Coordinates, Property, RoomKind, Stay } from '$lib/domain';
import { describe, expect, it } from 'vitest';
import { describePriceComparison, describeStayChoices, stayDistances } from './choice';
import type { PropertyStayOptions, StayOption } from './types';

const AIRPORT: Coordinates = { latitude: 48.11, longitude: 16.57 };
const CENTRE: Coordinates = { latitude: 48.2082, longitude: 16.3738 };

function makeProperty(name: string, coordinates: Coordinates = AIRPORT): Property {
	return { name, coordinates, images: [] };
}

function makeStay(property: Property, roomKind: RoomKind, minorUnits: number, currency = 'EUR'): Stay {
	return { property, roomKind, pricePerNight: { minorUnits, currency } };
}

function group(...options: StayOption[]): PropertyStayOptions {
	return { options };
}

const picked = makeProperty('Wombats');
const rival = makeProperty('Hostel Ruthensteiner', { latitude: 48.1966, longitude: 16.3362 });
const pickedStay = makeStay(picked, 'dorm', 2000);

describe('describeStayChoices', () => {
	it('measures every difference from the stay the itinerary books, per night and over the stay', () => {
		const [mine, theirs] = describeStayChoices([group({ stay: pickedStay }), group({ stay: makeStay(rival, 'dorm', 3200) })], {
			picked: pickedStay,
			connectionAirport: AIRPORT,
			nights: 3
		});

		expect(mine.isPicked).toBe(true);
		expect(mine.comparison).toEqual({ kind: 'picked' });
		expect(theirs.comparison).toEqual({
			kind: 'difference',
			perNight: { minorUnits: 1200, currency: 'EUR' },
			overStay: { minorUnits: 3600, currency: 'EUR' }
		});
	});

	it('signs a cheaper bed negative, which is what lets a row colour it', () => {
		const [, theirs] = describeStayChoices([group({ stay: pickedStay }), group({ stay: makeStay(rival, 'dorm', 1400) })], {
			picked: pickedStay,
			connectionAirport: AIRPORT,
			nights: 2
		});
		expect(theirs.comparison).toEqual({
			kind: 'difference',
			perNight: { minorUnits: -600, currency: 'EUR' },
			overStay: { minorUnits: -1200, currency: 'EUR' }
		});
	});

	/**
	 * The whole reason the nightly figure is the headline. A day stopover books no night,
	 * so every whole-stay total is zero and every whole-stay delta with it: a column
	 * reading "same price" against thirty beds at thirty different rates.
	 */
	it('keeps the nightly difference and drops the whole-stay one when the stopover books no night', () => {
		const [, theirs] = describeStayChoices([group({ stay: pickedStay }), group({ stay: makeStay(rival, 'dorm', 3200) })], {
			picked: pickedStay,
			connectionAirport: AIRPORT,
			nights: 0
		});
		expect(theirs.comparison).toEqual({
			kind: 'difference',
			perNight: { minorUnits: 1200, currency: 'EUR' }
		});
	});

	it('says which currency rather than subtracting two of them', () => {
		const [, theirs] = describeStayChoices(
			[group({ stay: pickedStay }), group({ stay: makeStay(rival, 'dorm', 3200, 'USD') })],
			{ picked: pickedStay, connectionAirport: AIRPORT, nights: 2 }
		);
		expect(theirs.comparison).toEqual({ kind: 'other-currency', currency: 'USD' });
	});

	it('reports an equal rate as equal rather than as a zero', () => {
		const [, theirs] = describeStayChoices([group({ stay: pickedStay }), group({ stay: makeStay(rival, 'dorm', 2000) })], {
			picked: pickedStay,
			connectionAirport: AIRPORT,
			nights: 2
		});
		expect(theirs.comparison).toEqual({ kind: 'same' });
	});

	it('has no price and a stated reason where the group can book nothing', () => {
		const womenOnly = makeProperty('Female floor');
		const [choice] = describeStayChoices([group({ stay: makeStay(womenOnly, 'female-dorm', 1500) })], {
			picked: pickedStay,
			connectionAirport: AIRPORT,
			nights: 2,
			travellers: 2,
			females: 0
		});
		expect(choice.cheapest).toBeUndefined();
		expect(choice.total).toBeUndefined();
		expect(choice.comparison).toEqual({ kind: 'unbookable' });
		expect(choice.unavailableReason).toBeTruthy();
	});

	it('prices the cheapest room the group can book, not the cheapest room', () => {
		const mixed = group(
			{ stay: makeStay(rival, 'female-dorm', 1000) },
			{ stay: makeStay(rival, 'dorm', 1800) },
			{ stay: makeStay(rival, 'private', 5000) }
		);
		const [choice] = describeStayChoices([mixed], {
			picked: pickedStay,
			connectionAirport: AIRPORT,
			nights: 2,
			travellers: 2,
			females: 0
		});
		expect(choice.cheapest?.stay.pricePerNight.minorUnits).toBe(1800);
		expect(choice.total).toEqual({ minorUnits: 3600, currency: 'EUR' });
	});

	it('drops the centre distance when the airport has no hand-checked city point', () => {
		const [withCentre] = describeStayChoices([group({ stay: makeStay(rival, 'dorm', 1800) })], {
			picked: pickedStay,
			connectionAirport: AIRPORT,
			cityCentre: CENTRE,
			nights: 1
		});
		const [without] = describeStayChoices([group({ stay: makeStay(rival, 'dorm', 1800) })], {
			picked: pickedStay,
			connectionAirport: AIRPORT,
			nights: 1
		});
		expect(stayDistances(withCentre)).toHaveLength(2);
		expect(stayDistances(without)).toEqual([{ from: 'airport', distance: '19.8 km' }]);
	});
});

describe('describePriceComparison', () => {
	it('leads with the nightly figure and follows with the stay', () => {
		expect(
			describePriceComparison(
				{
					kind: 'difference',
					perNight: { minorUnits: 1200, currency: 'EUR' },
					overStay: { minorUnits: 3600, currency: 'EUR' }
				},
				3
			)
		).toEqual({ headline: '+€12.00/night', overStay: '+€36.00 over 3 nights', cheaper: false });
	});

	it('writes one night singular', () => {
		expect(
			describePriceComparison(
				{
					kind: 'difference',
					perNight: { minorUnits: -600, currency: 'EUR' },
					overStay: { minorUnits: -600, currency: 'EUR' }
				},
				1
			)
		).toEqual({ headline: '-€6.00/night', overStay: '-€6.00 over 1 night', cheaper: true });
	});

	it('says nothing for the row that is already picked, and nothing for one with no price', () => {
		expect(describePriceComparison({ kind: 'picked' }, 2)).toBeUndefined();
		expect(describePriceComparison({ kind: 'unbookable' }, 2)).toBeUndefined();
	});

	it('names the currency instead of a number it cannot compute', () => {
		expect(describePriceComparison({ kind: 'other-currency', currency: 'USD' }, 2)?.headline).toBe('Priced in USD');
	});
});
