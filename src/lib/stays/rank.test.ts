import type { Coordinates, Property, RoomKind, Stay } from '$lib/domain';
import { describe, expect, it } from 'vitest';
import type { StopoverForRanking } from './rank';
import {
	cheapestSelectableOption,
	countPropertiesByBedKind,
	isOptionSelectable,
	isPropertyOnOffer,
	rankProperties,
	selectableOptions
} from './rank';
import type { BedKind } from './room-kind';
import type { PropertyStayOptions, StayOption } from './types';

const AIRPORT: Coordinates = { latitude: 48.11, longitude: 16.57 };

/** Every property in these tests sits at the airport itself unless a case is about
 * distance, so the ordering they assert is the one they mean to assert. */
function makeProperty(name: string, coordinates: Coordinates = AIRPORT): Property {
	return { name, coordinates, images: [] };
}

/** A point `km` due north of the airport, so a test can name a distance rather than a
 * latitude. One degree of latitude is 111.19 km on this module's Earth radius. */
function kmFromAirport(km: number): Coordinates {
	return { latitude: AIRPORT.latitude + km / 111.19, longitude: AIRPORT.longitude };
}

/** The stopover city's centre, 40.1 km out, which is `search/resources.ts`' measured
 * Gatwick-to-central-London figure and the geometry the Gatwick cases below stand on. */
const CITY_CENTRE = kmFromAirport(40.1);

/** No days out and no city point, which is the stopover a traveller only sleeps in, and
 * what every case in this file assumed before the days-out rule existed. */
function stopover(nights: number, travellers?: number, females?: number): StopoverForRanking {
	return { travellers, females, connectionAirport: AIRPORT, nights, visitDays: 0 };
}

/** The same stopover with free time in it: `visitDays` days the traveller spends in a city
 * that has a centre to go to. */
function stopoverWithDaysOut(nights: number, visitDays: number): StopoverForRanking {
	return { ...stopover(nights), cityCentre: CITY_CENTRE, visitDays };
}

function makeStay(property: Property, roomKind: RoomKind, minorUnits: number): Stay {
	return { property, roomKind, pricePerNight: { minorUnits, currency: 'EUR' } };
}

function group(options: StayOption[]): PropertyStayOptions {
	return { options };
}

describe('isOptionSelectable / selectableOptions', () => {
	const property = makeProperty("Wombat's City Hostel");

	it('always allows a plain dorm or private room, regardless of the group\'s gender mix', () => {
		const dorm: StayOption = { stay: makeStay(property, 'dorm', 2000) };
		const priv: StayOption = { stay: makeStay(property, 'private', 8000) };
		expect(isOptionSelectable(dorm, 4, 0)).toBe(true);
		expect(isOptionSelectable(priv, 4, 0)).toBe(true);
	});

	it('excludes a female-only dorm when the group has no female travellers', () => {
		const femaleDorm: StayOption = { stay: makeStay(property, 'female-dorm', 1800) };
		expect(isOptionSelectable(femaleDorm, 4, 0)).toBe(false);
	});

	it('excludes a female-only dorm for a mixed group', () => {
		const femaleDorm: StayOption = { stay: makeStay(property, 'female-dorm', 1800) };
		expect(isOptionSelectable(femaleDorm, 4, 2)).toBe(false);
	});

	it('includes a female-only dorm when the whole group is female', () => {
		const femaleDorm: StayOption = { stay: makeStay(property, 'female-dorm', 1800) };
		expect(isOptionSelectable(femaleDorm, 3, 3)).toBe(true);
	});

	it('filters a mixed options list down to what the group can book', () => {
		const options: StayOption[] = [
			{ stay: makeStay(property, 'female-dorm', 1500) },
			{ stay: makeStay(property, 'dorm', 2000) },
			{ stay: makeStay(property, 'private', 8000) }
		];
		const g = group(options);
		expect(selectableOptions(g, 2, 0).map((o) => o.stay.roomKind)).toEqual(['dorm', 'private']);
	});
});

describe('cheapestSelectableOption - the "never offered as its cheapest option" rule', () => {
	const property = makeProperty("Wombat's City Hostel");

	it('never returns a female-only dorm as cheapest for a group with no female travellers, even when it really is the lowest price', () => {
		const g = group([
			{ stay: makeStay(property, 'female-dorm', 1000) }, // cheapest by price, but not bookable
			{ stay: makeStay(property, 'dorm', 2200) },
			{ stay: makeStay(property, 'private', 9000) }
		]);
		const cheapest = cheapestSelectableOption(g, 4, 0);
		expect(cheapest?.stay.roomKind).toBe('dorm');
		expect(cheapest?.stay.pricePerNight.minorUnits).toBe(2200);
	});

	it('never returns a female-only dorm as cheapest for a mixed group either', () => {
		const g = group([
			{ stay: makeStay(property, 'female-dorm', 1000) },
			{ stay: makeStay(property, 'dorm', 2200) }
		]);
		expect(cheapestSelectableOption(g, 4, 1)?.stay.roomKind).toBe('dorm');
	});

	it('is undefined when every option at a property is ineligible', () => {
		const g = group([{ stay: makeStay(property, 'female-dorm', 1000) }]);
		expect(cheapestSelectableOption(g, 4, 0)).toBeUndefined();
	});

	it('does return the female-only dorm when the whole group is female and it is cheapest', () => {
		const g = group([
			{ stay: makeStay(property, 'female-dorm', 1000) },
			{ stay: makeStay(property, 'dorm', 2200) }
		]);
		expect(cheapestSelectableOption(g, 2, 2)?.stay.roomKind).toBe('female-dorm');
	});
});

describe('rankProperties', () => {
	it('orders properties cheapest-first by what the group can actually book', () => {
		const cheapButFemaleOnly = makeProperty('Cheap Female-Only Hostel');
		const midPrice = makeProperty('Mid Hostel');
		const properties: PropertyStayOptions[] = [
			group([{ stay: makeStay(midPrice, 'dorm', 2500) }]),
			group([{ stay: makeStay(cheapButFemaleOnly, 'female-dorm', 1000) }])
		];
		// A group with no female travellers cannot book the cheaper property at all, so
		// the mid-priced, actually-bookable one must rank first.
		const ranked = rankProperties(properties, stopover(1, 4, 0));
		expect(ranked[0].options[0].stay.property.name).toBe('Mid Hostel');
		expect(ranked[1].options[0].stay.property.name).toBe('Cheap Female-Only Hostel');
	});

	it('sorts a property with no bookable option last rather than dropping it', () => {
		const properties: PropertyStayOptions[] = [
			group([{ stay: makeStay(makeProperty('A'), 'female-dorm', 1000) }]),
			group([{ stay: makeStay(makeProperty('B'), 'dorm', 3000) }])
		];
		const ranked = rankProperties(properties, stopover(1, 2, 0));
		expect(ranked.map((p) => p.options[0].stay.property.name)).toEqual(['B', 'A']);
	});

	it('does not mutate the input array', () => {
		const properties: PropertyStayOptions[] = [
			group([{ stay: makeStay(makeProperty('A'), 'dorm', 5000) }]),
			group([{ stay: makeStay(makeProperty('B'), 'dorm', 1000) }])
		];
		const original = [...properties];
		rankProperties(properties, stopover(1, 1, undefined));
		expect(properties).toEqual(original);
	});
});

describe('rankProperties — how far the bed is (issue #219)', () => {
	/** The two beds off the owner's own Gatwick card, at their measured distances and
	 * prices: a EUR 13.00 dorm 48.3 km away in London, and a EUR 52.82 room 2.8 km from
	 * the terminal in Horley. */
	function gatwickList(): PropertyStayOptions[] {
		return [
			group([{ stay: makeStay(makeProperty('London Backpackers', kmFromAirport(48.3)), 'dorm', 1300) }]),
			group([
				{ stay: makeStay(makeProperty('The Gatwick White House Hotel', kmFromAirport(2.8)), 'private', 5282) }
			])
		];
	}

	it('puts the walkable room first for one night, not last of the list', () => {
		const ranked = rankProperties(gatwickList(), stopover(1));
		expect(ranked[0].options[0].stay.property.name).toBe('The Gatwick White House Hotel');
	});

	it('hands the city dorm back once the stopover is long enough to pay for the journey', () => {
		// The nightly saving is EUR 39.82 and the round trip out to London costs about
		// EUR 127, so the crossover sits between three nights and four. That shape is the
		// point of the rule: sleep by the runway for one night, go into town for four.
		expect(rankProperties(gatwickList(), stopover(3))[0].options[0].stay.property.name).toBe(
			'The Gatwick White House Hotel'
		);
		expect(rankProperties(gatwickList(), stopover(4))[0].options[0].stay.property.name).toBe(
			'London Backpackers'
		);
	});

	it('still ranks two beds at the same distance on price alone', () => {
		const properties: PropertyStayOptions[] = [
			group([{ stay: makeStay(makeProperty('Dearer', kmFromAirport(12)), 'dorm', 4000) }]),
			group([{ stay: makeStay(makeProperty('Cheaper', kmFromAirport(12)), 'dorm', 2000) }])
		];
		expect(rankProperties(properties, stopover(2)).map((p) => p.options[0].stay.property.name)).toEqual([
			'Cheaper',
			'Dearer'
		]);
	});

	it('leaves the order alone when the stopover has no day to spend in the city', () => {
		// Every ordering this file asserted before the days-out rule existed is this case,
		// and the centre term has to be worth exactly nothing in it.
		const ranked = rankProperties(gatwickList(), stopoverWithDaysOut(1, 0));
		expect(ranked.map((p) => p.options[0].stay.property.name)).toEqual([
			'The Gatwick White House Hotel',
			'London Backpackers'
		]);
	});

	it('pulls the list toward the centre as the days out add up', () => {
		// One day in London costs the Horley room EUR 110.44 of taxis to the centre and the
		// dorm EUR 28.96, against a EUR 87.59 head start the room has after one night. The
		// second day is what pays that off, so the crossover sits between one day and two.
		expect(rankProperties(gatwickList(), stopoverWithDaysOut(1, 1))[0].options[0].stay.property.name).toBe(
			'The Gatwick White House Hotel'
		);
		expect(rankProperties(gatwickList(), stopoverWithDaysOut(1, 2))[0].options[0].stay.property.name).toBe(
			'London Backpackers'
		);
	});

	it('never lets distance rescue a bed the group cannot book', () => {
		// Issue #80's rule outranks this one: a female-only dorm at the terminal is still
		// unbookable for a group with no female travellers, however near it is.
		const properties: PropertyStayOptions[] = [
			group([{ stay: makeStay(makeProperty('At the gate', kmFromAirport(0.2)), 'female-dorm', 900) }]),
			group([{ stay: makeStay(makeProperty('Across town', kmFromAirport(30)), 'dorm', 2000) }])
		];
		const ranked = rankProperties(properties, stopover(1, 4, 0));
		expect(ranked.map((p) => p.options[0].stay.property.name)).toEqual(['Across town', 'At the gate']);
	});
});

describe('the bed-kind filter (issue #423)', () => {
	const DORMS_ONLY = new Set<BedKind>(['dorm']);
	const PRIVATE_ONLY = new Set<BedKind>(['private']);

	const mixed = makeProperty('Wombats City Hostel');
	const dormOnly = makeProperty('Hostel Ruthensteiner');
	const cheapDorm: StayOption = { stay: makeStay(mixed, 'dorm', 1300) };
	const dearRoom: StayOption = { stay: makeStay(mixed, 'private', 4000) };

	// The exact bug a naive filter ships: filtering finished `StayChoice`s on
	// `cheapest.stay.roomKind` reads this property's EUR 13.00 dorm and throws away the
	// private room the traveller asked for.
	it('keeps a property that also has a dorm, and resolves it to the private room', () => {
		const property = group([cheapDorm, dearRoom]);
		expect(cheapestSelectableOption(property, 2, 1, PRIVATE_ONLY)).toBe(dearRoom);
		expect(selectableOptions(property, 2, 1, PRIVATE_ONLY)).toEqual([dearRoom]);
		expect(isPropertyOnOffer(property, 2, 1, PRIVATE_ONLY)).toBe(true);
	});

	it('ranks on the price of the kind asked for, not on the cheapest room in the building', () => {
		// The dorm-only hostel is cheaper than the mixed one's dorm and dearer than nothing at
		// all, so a filter that ranked on the unfiltered cheapest would put it first.
		const budget = group([{ stay: makeStay(dormOnly, 'dorm', 1100) }]);
		const properties = [group([cheapDorm, dearRoom]), budget];

		expect(rankProperties(properties, stopover(2, 2, 1))[0]).toBe(budget);
		expect(rankProperties(properties, { ...stopover(2, 2, 1), bedKinds: PRIVATE_ONLY })[0]).toBe(properties[0]);
	});

	it('drops a property with nothing of that kind, and keeps a gender-blocked one', () => {
		const dormHostel = group([{ stay: makeStay(dormOnly, 'dorm', 1100) }]);
		const womenOnly = group([{ stay: makeStay(makeProperty('Hostelle'), 'female-dorm', 900) }]);

		// The traveller chose to hide this one, so it goes.
		expect(isPropertyOnOffer(dormHostel, 2, 0, PRIVATE_ONLY)).toBe(false);
		// Nobody in this party can book this one whatever they click, so it stays with its
		// reason on it rather than vanishing under a control that did not cause it.
		expect(isPropertyOnOffer(womenOnly, 2, 0, PRIVATE_ONLY)).toBe(true);
		expect(isPropertyOnOffer(womenOnly, 2, 0, DORMS_ONLY)).toBe(true);
	});

	it('composes with gender fit rather than overriding it', () => {
		const femaleDorm: StayOption = { stay: makeStay(dormOnly, 'female-dorm', 900) };
		// A female-only dorm is a dorm, so the kind test passes and the group test still fails.
		expect(isOptionSelectable(femaleDorm, 2, 0, DORMS_ONLY)).toBe(false);
		expect(isOptionSelectable(femaleDorm, 2, 2, DORMS_ONLY)).toBe(true);
		expect(isOptionSelectable(femaleDorm, 2, 2, PRIVATE_ONLY)).toBe(false);
	});

	it('changes nothing at all for an empty set', () => {
		const property = group([cheapDorm, dearRoom]);
		const empty = new Set<BedKind>();
		expect(selectableOptions(property, 2, 1, empty)).toEqual(selectableOptions(property, 2, 1));
		expect(cheapestSelectableOption(property, 2, 1, empty)).toBe(cheapestSelectableOption(property, 2, 1));

		const properties = [group([{ stay: makeStay(dormOnly, 'dorm', 1100) }]), property];
		expect(rankProperties(properties, { ...stopover(2, 2, 1), bedKinds: empty })).toEqual(
			rankProperties(properties, stopover(2, 2, 1))
		);
	});
});

describe('countPropertiesByBedKind', () => {
	const both = makeProperty('Wombats City Hostel');
	const dormHostel = makeProperty('Hostel Ruthensteiner');
	const hotel = makeProperty('Hotel Post');
	const womenOnly = makeProperty('Hostelle');

	const properties = [
		group([{ stay: makeStay(both, 'dorm', 1300) }, { stay: makeStay(both, 'private', 4000) }]),
		group([{ stay: makeStay(dormHostel, 'dorm', 1100) }, { stay: makeStay(dormHostel, 'female-dorm', 1000) }]),
		group([{ stay: makeStay(hotel, 'private', 5200) }]),
		group([{ stay: makeStay(womenOnly, 'female-dorm', 900) }])
	];

	it('counts a property once per kind it offers, however many rooms of that kind it has', () => {
		// The second property prices two dorms; it is one dorm property, not two.
		expect(countPropertiesByBedKind(properties, 2, 2)).toEqual({ dorm: 3, private: 2 });
	});

	it('leaves out a room this group cannot book, so the chip never promises one', () => {
		// With no female travellers the women-only hostel drops out of the dorm count
		// entirely, and the mixed-dorm hostel keeps its place on its plain dorm.
		expect(countPropertiesByBedKind(properties, 2, 0)).toEqual({ dorm: 2, private: 2 });
	});
});
