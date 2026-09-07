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
			{ src: BUNKS, subject: 'room', caption: 'Female-only dorm at Rest Up London' }
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
			{ src: BUNKS, subject: 'room', caption: 'Female-only dorm and male-only dorm at Rest Up London' },
			{ src: SHOWER, subject: 'room', caption: 'Male-only dorm at Rest Up London' }
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
