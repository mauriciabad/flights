import type { Property, RoomKind, Stay } from '$lib/domain';
import { describe, expect, it } from 'vitest';
import { cheapestSelectableOption, isOptionSelectable, rankProperties, selectableOptions } from './rank';
import type { PropertyStayOptions, StayOption } from './types';

function makeProperty(name: string): Property {
	return { name, coordinates: { latitude: 48.2, longitude: 16.37 }, images: [] };
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
		const ranked = rankProperties(properties, 4, 0);
		expect(ranked[0].options[0].stay.property.name).toBe('Mid Hostel');
		expect(ranked[1].options[0].stay.property.name).toBe('Cheap Female-Only Hostel');
	});

	it('sorts a property with no bookable option last rather than dropping it', () => {
		const properties: PropertyStayOptions[] = [
			group([{ stay: makeStay(makeProperty('A'), 'female-dorm', 1000) }]),
			group([{ stay: makeStay(makeProperty('B'), 'dorm', 3000) }])
		];
		const ranked = rankProperties(properties, 2, 0);
		expect(ranked.map((p) => p.options[0].stay.property.name)).toEqual(['B', 'A']);
	});

	it('does not mutate the input array', () => {
		const properties: PropertyStayOptions[] = [
			group([{ stay: makeStay(makeProperty('A'), 'dorm', 5000) }]),
			group([{ stay: makeStay(makeProperty('B'), 'dorm', 1000) }])
		];
		const original = [...properties];
		rankProperties(properties, 1, undefined);
		expect(properties).toEqual(original);
	});
});
