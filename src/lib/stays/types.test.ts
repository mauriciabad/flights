import type { Property, Stay } from '$lib/domain';
import { describe, expect, it } from 'vitest';
import { groupByProperty, propertyOf } from './types';

describe('propertyOf', () => {
	it('reads the property from the first option, since every option in a group shares one', () => {
		const property: Property = { name: 'Test Hostel', coordinates: { latitude: 0, longitude: 0 }, images: [] };
		const stay: Stay = { property, roomKind: 'dorm', pricePerNight: { minorUnits: 1000, currency: 'EUR' } };
		expect(propertyOf({ options: [{ stay }] })).toBe(property);
	});
});

describe('groupByProperty', () => {
	it('groups stays that share the same Property object into one entry', () => {
		const property: Property = { name: 'Wombats City Hostel', coordinates: { latitude: 48.2, longitude: 16.37 }, images: [] };
		const dorm: Stay = { property, roomKind: 'dorm', pricePerNight: { minorUnits: 2000, currency: 'EUR' } };
		const priv: Stay = { property, roomKind: 'private', pricePerNight: { minorUnits: 8000, currency: 'EUR' } };

		const groups = groupByProperty([dorm, priv]);

		expect(groups).toHaveLength(1);
		expect(groups[0].options.map((o) => o.stay)).toEqual([dorm, priv]);
	});

	it('keeps two properties separate even when their names match, since they are different objects', () => {
		// Mirrors two different adapters (Agoda, Booking) each building their own Property
		// literal for what might be the same real hostel - groupByProperty must not
		// pretend it knows they are the same place.
		const propertyFromAgoda: Property = {
			name: 'Wombats City Hostel',
			coordinates: { latitude: 48.2, longitude: 16.37 },
			images: []
		};
		const propertyFromBooking: Property = {
			name: 'Wombats City Hostel',
			coordinates: { latitude: 48.2, longitude: 16.37 },
			images: []
		};
		const a: Stay = { property: propertyFromAgoda, roomKind: 'dorm', pricePerNight: { minorUnits: 2000, currency: 'EUR' } };
		const b: Stay = { property: propertyFromBooking, roomKind: 'dorm', pricePerNight: { minorUnits: 2100, currency: 'EUR' } };

		expect(groupByProperty([a, b])).toHaveLength(2);
	});

	it('returns an empty array for an empty input', () => {
		expect(groupByProperty([])).toEqual([]);
	});

	it('preserves the first-seen order of each property', () => {
		const propertyA: Property = { name: 'A', coordinates: { latitude: 0, longitude: 0 }, images: [] };
		const propertyB: Property = { name: 'B', coordinates: { latitude: 1, longitude: 1 }, images: [] };
		const stays: Stay[] = [
			{ property: propertyB, roomKind: 'dorm', pricePerNight: { minorUnits: 1000, currency: 'EUR' } },
			{ property: propertyA, roomKind: 'dorm', pricePerNight: { minorUnits: 1000, currency: 'EUR' } },
			{ property: propertyB, roomKind: 'private', pricePerNight: { minorUnits: 5000, currency: 'EUR' } }
		];
		const groups = groupByProperty(stays);
		expect(groups.map((g) => propertyOf(g).name)).toEqual(['B', 'A']);
		expect(groups[0].options).toHaveLength(2);
	});
});
