import { describe, expect, it } from 'vitest';
import type { Property, RoomKind, Stay } from '../domain';
import { photoAlt, stayPhotos } from './stay-photos';

/**
 * Issue #442's one rule is that a photograph of the building may never be presented as a
 * photograph of the room, and this is the only function in the app that decides which is
 * which. Everything below is that rule from a different angle.
 */

const LOBBY = 'https://fixture.invalid/photos/lobby.jpg';
const FRONT = 'https://fixture.invalid/photos/front.jpg';
const BUNKS = 'https://fixture.invalid/photos/bunks.jpg';
const SHOWER = 'https://fixture.invalid/photos/shower.jpg';

const property: Property = {
	name: 'Rest Up London',
	coordinates: { latitude: 51.49, longitude: -0.09 },
	images: [LOBBY, FRONT]
};

function stay(roomKind: RoomKind, roomImages?: string[]): Stay {
	return {
		property,
		roomKind,
		pricePerNight: { minorUnits: 1907, currency: 'EUR' },
		...(roomImages ? { roomImages } : {})
	};
}

describe('stayPhotos', () => {
	it('is the building alone when no room was photographed', () => {
		expect(stayPhotos(property, [stay('dorm')])).toEqual([
			{ src: LOBBY, subject: 'property', caption: 'Rest Up London' },
			{ src: FRONT, subject: 'property', caption: 'Rest Up London' }
		]);
	});

	it('is the building alone when no room is in view at all', () => {
		expect(stayPhotos(property).map((photo) => photo.subject)).toEqual(['property', 'property']);
	});

	it('puts the room after the building and says which room it is', () => {
		const photos = stayPhotos(property, [stay('female-dorm', [BUNKS])]);
		expect(photos).toEqual([
			{ src: LOBBY, subject: 'property', caption: 'Rest Up London' },
			{ src: FRONT, subject: 'property', caption: 'Rest Up London' },
			{ src: BUNKS, subject: 'room', caption: 'Female-only dorm at Rest Up London', badge: 'Room' }
		]);
	});

	it('names every room kind that publishes the same photograph', () => {
		// Measured at Hostelworld property 312244: the female dorm and the mixed dorm publish
		// the same three addresses. Naming only the first would put a claim on the picture
		// that is wrong for the other half of the time.
		const photos = stayPhotos(property, [
			stay('female-dorm', [BUNKS]),
			stay('male-dorm', [BUNKS, SHOWER])
		]);
		expect(photos.filter((photo) => photo.subject === 'room')).toEqual([
			{
				src: BUNKS,
				subject: 'room',
				caption: 'Female-only dorm and male-only dorm at Rest Up London',
				badge: 'Room'
			},
			{ src: SHOWER, subject: 'room', caption: 'Male-only dorm at Rest Up London', badge: 'Room' }
		]);
	});

	it('keeps a photograph the property also publishes as the building itself', () => {
		// Of the two readings, the building is the one that cannot mislead. Nobody is
		// disappointed to find the exterior is also filed under the room.
		const photos = stayPhotos(property, [stay('private', [FRONT, SHOWER])]);
		expect(photos.map((photo) => [photo.src, photo.subject])).toEqual([
			[LOBBY, 'property'],
			[FRONT, 'property'],
			[SHOWER, 'room']
		]);
	});

	it('shows one property photograph once however many times it is listed', () => {
		const twice: Property = { ...property, images: [LOBBY, LOBBY, FRONT] };
		expect(stayPhotos(twice, []).map((photo) => photo.src)).toEqual([LOBBY, FRONT]);
	});

	it('is empty for a property that came back without a picture', () => {
		expect(stayPhotos({ ...property, images: [] }, [stay('dorm')])).toEqual([]);
	});
});

describe('stayPhotos, the rooms a provider answered about on demand (issue #449)', () => {
	/**
	 * The judgement call this whole issue turns on. A `dorm` and a `private` are priced from a
	 * property-level average no single room quotes, so no photograph is of the room whose rate
	 * is on screen, and the mapper has always refused to pretend otherwise. That refusal left
	 * the two commonest kinds with nothing: 128 of the 228 rooms across thirty live London
	 * properties are mixed dorms and 52 are privates (2026-09-08).
	 *
	 * These are the weaker true claim in its place, and the tests that keep it weak.
	 */
	const lookup = {
		provider: 'hostelworld' as const,
		byRoomId: { '851743': [BUNKS] },
		byKind: { dorm: [SHOWER], private: [FRONT] }
	};

	function sourced(roomKind: RoomKind, roomId?: string): Stay {
		return {
			...stay(roomKind),
			source: { provider: 'hostelworld' as const, propertyId: '312244', ...(roomId ? { roomId } : {}) }
		};
	}

	it('calls a room-kind photograph what it is, in the plural, and never "Room"', () => {
		const photos = stayPhotos(property, [sourced('dorm')], lookup);
		expect(photos.filter((photo) => photo.subject !== 'property')).toEqual([
			{
				src: SHOWER,
				subject: 'room-kind',
				caption: 'Dorm rooms at Rest Up London',
				badge: 'Dorm rooms'
			}
		]);
	});

	it('gives the exact room the strong claim when the provider named one', () => {
		const photos = stayPhotos(property, [sourced('female-dorm', '851743')], lookup);
		expect(photos.filter((photo) => photo.subject !== 'property')).toEqual([
			{
				src: BUNKS,
				subject: 'room',
				caption: 'Female-only dorm at Rest Up London',
				badge: 'Room'
			}
		]);
	});

	it('never mixes one kind\'s rooms into another kind\'s claim', () => {
		// #27 and #288: a restricted dorm is different inventory from a mixed one, so a private
		// room's photograph under a dorm price would be the same category error one layer up.
		const photos = stayPhotos(property, [sourced('private')], lookup);
		expect(photos.filter((photo) => photo.subject !== 'property').map((photo) => photo.src)).toEqual([]);
		// FRONT is in `byKind.private`, and it is also one of the building's own, which wins.
		expect(photos.map((photo) => photo.subject)).toEqual(['property', 'property']);
	});

	it('prefers the strong claim when one photograph carries both', () => {
		const both = {
			provider: 'hostelworld' as const,
			byRoomId: { '851743': [BUNKS] },
			byKind: { 'female-dorm': [BUNKS] }
		};
		const photos = stayPhotos(
			property,
			[sourced('female-dorm', '851743'), sourced('female-dorm')],
			both
		);
		const rooms = photos.filter((photo) => photo.subject !== 'property');
		expect(rooms).toHaveLength(1);
		expect(rooms[0].subject).toBe('room');
	});

	it('falls back to the kind when the named room is not in the answer', () => {
		// A room sold out between the search and the look is an ordinary result, not a reason
		// to show nothing.
		const photos = stayPhotos(property, [sourced('dorm', '999999')], lookup);
		expect(photos.filter((photo) => photo.subject === 'room-kind').map((photo) => photo.src)).toEqual([
			SHOWER
		]);
	});

	it('still offers the kind to a stay with no provider identity on it', () => {
		// Every `Stay` in a cache or a saved trip written before #450 is this one, and so is
		// every Booking or Agoda stay merged into the same building. "These are the dorms at
		// this property" is a claim about the building, and `groupByProperty` only merged the
		// two records because it is one building, so it holds for both.
		const photos = stayPhotos(property, [stay('dorm')], lookup);
		expect(photos.map((photo) => photo.subject)).toEqual(['property', 'property', 'room-kind']);
	});

	it('refuses another provider\'s room id, whose numbers mean nothing here', () => {
		const elsewhere: Stay = {
			...stay('female-dorm'),
			source: { provider: 'booking', propertyId: '71662', roomId: '851743' }
		};
		const photos = stayPhotos(property, [elsewhere], lookup);
		// Not BUNKS under a "Room" badge. `byKind` has no `female-dorm` entry either, so this
		// property shows what it showed before.
		expect(photos.map((photo) => photo.subject)).toEqual(['property', 'property']);
	});

	it('says "Rooms" rather than a list when two kinds share one picture', () => {
		const shared = {
			provider: 'hostelworld' as const,
			byRoomId: {},
			byKind: { dorm: [SHOWER], private: [SHOWER] }
		};
		const photos = stayPhotos(property, [sourced('dorm'), sourced('private')], shared);
		const room = photos.find((photo) => photo.subject === 'room-kind');
		expect(room?.badge).toBe('Rooms');
		expect(room?.caption).toBe('Dorm rooms and private rooms at Rest Up London');
	});
});

describe('photoAlt', () => {
	it('says which of how many, so a reader who cannot see the counter still knows', () => {
		const photo = { src: BUNKS, subject: 'room' as const, caption: 'Dorm bed at Rest Up London' };
		expect(photoAlt(photo, 2, 5)).toBe('Dorm bed at Rest Up London, photo 2 of 5');
	});

	it('drops the position when there is only one', () => {
		const photo = { src: LOBBY, subject: 'property' as const, caption: 'Rest Up London' };
		expect(photoAlt(photo, 1, 1)).toBe('Rest Up London');
	});
});
