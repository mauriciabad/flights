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

	it('groups a property that came back through the cache, where identity is gone', () => {
		// The #188 crash. A stay read out of IndexedDB has been through JSON, so each one
		// carries its own structurally-equal Property. Grouping on identity gave one group
		// per room price, StayPicker keys its {#each} on name plus coordinates, the repeats
		// collided, and Svelte threw each_key_duplicate and took the detail panel with it.
		const afterJson = (): Property => ({
			name: 'Wombats City Hostel',
			coordinates: { latitude: 48.2, longitude: 16.37 },
			images: []
		});
		const dorm: Stay = { property: afterJson(), roomKind: 'dorm', pricePerNight: { minorUnits: 2946, currency: 'EUR' } };
		const priv: Stay = { property: afterJson(), roomKind: 'private', pricePerNight: { minorUnits: 13311, currency: 'EUR' } };

		const groups = groupByProperty([dorm, priv]);

		expect(groups).toHaveLength(1);
		expect(groups[0].options).toHaveLength(2);
	});

	it('merges two adapters describing the same hostel, keeping the cheaper price per room kind', () => {
		// This reverses an earlier decision to keep them apart. That decision was made to
		// avoid merging two price lists on a guess, but it only ever held while Property
		// identity survived, and it does not survive the cache. Exact agreement on name and
		// on both coordinates is a strong enough signal, and showing the owner the same
		// hostel twice is the worse failure.
		const here = { latitude: 48.2, longitude: 16.37 };
		const fromAgoda: Stay = {
			property: { name: 'Wombats City Hostel', coordinates: here, images: [] },
			roomKind: 'dorm',
			pricePerNight: { minorUnits: 2100, currency: 'EUR' }
		};
		const fromBooking: Stay = {
			property: { name: 'Wombats City Hostel', coordinates: here, images: [] },
			roomKind: 'dorm',
			pricePerNight: { minorUnits: 2000, currency: 'EUR' }
		};

		const groups = groupByProperty([fromAgoda, fromBooking]);

		expect(groups).toHaveLength(1);
		expect(groups[0].options).toHaveLength(1);
		expect(groups[0].options[0].stay.pricePerNight.minorUnits).toBe(2000);
	});

	it('does not compare prices across currencies, since minor units are not ordered between them', () => {
		const here = { latitude: 48.2, longitude: 16.37 };
		const inEuros: Stay = {
			property: { name: 'Wombats City Hostel', coordinates: here, images: [] },
			roomKind: 'dorm',
			pricePerNight: { minorUnits: 2000, currency: 'EUR' }
		};
		const inForint: Stay = {
			property: { name: 'Wombats City Hostel', coordinates: here, images: [] },
			roomKind: 'dorm',
			pricePerNight: { minorUnits: 8000, currency: 'HUF' }
		};

		const groups = groupByProperty([inEuros, inForint]);

		expect(groups[0].options).toHaveLength(1);
		expect(groups[0].options[0].stay.pricePerNight.currency).toBe('EUR');
	});

	it('keeps genuinely different properties apart', () => {
		const a: Stay = {
			property: { name: 'Wombats City Hostel', coordinates: { latitude: 48.2, longitude: 16.37 }, images: [] },
			roomKind: 'dorm',
			pricePerNight: { minorUnits: 2000, currency: 'EUR' }
		};
		const b: Stay = {
			property: { name: 'Wombats City Hostel', coordinates: { latitude: 47.5, longitude: 19.05 }, images: [] },
			roomKind: 'dorm',
			pricePerNight: { minorUnits: 2100, currency: 'EUR' }
		};

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
