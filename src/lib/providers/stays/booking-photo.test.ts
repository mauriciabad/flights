import { describe, expect, it } from 'vitest';
import { originalBookingPhoto, upgradeBookingPhoto } from './booking-photo';
import searchFixture from './fixtures/booking-search-vienna.json';
import type { BookingSearchResponse } from './booking-types';

/**
 * The measurement these two functions exist for is in `booking-photo.ts`. What is pinned
 * here is that the swap only ever touches a shape it recognises, and that it is exactly
 * reversible, because reversibility is the whole reason the rewrite is safe to ship
 * against three measured photo ids rather than every photo id Booking holds.
 */

const SQUARE_60 =
	'https://cf.bstatic.com/xdata/images/hotel/square60/751028262.jpg?k=763506dd&o=';
const CARD =
	'https://cf.bstatic.com/xdata/images/hotel/max1024x768/751028262.jpg?k=763506dd&o=';

describe('upgradeBookingPhoto', () => {
	it('moves the size segment and leaves the photo id and its signature alone', () => {
		expect(upgradeBookingPhoto(SQUARE_60)).toBe(CARD);
	});

	it('upgrades every photo the real search fixture carries', () => {
		const results = (searchFixture as BookingSearchResponse).data?.result ?? [];
		const photos = results
			.map((r) => r.main_photo_url)
			.filter((url): url is string => typeof url === 'string');
		// Three, and the test is worthless if the fixture ever stops carrying them.
		expect(photos.length).toBeGreaterThan(0);
		for (const url of photos) {
			expect(url).toContain('/square60/');
			expect(upgradeBookingPhoto(url)).toContain('/max1024x768/');
		}
	});

	it('leaves a URL it does not recognise exactly as it found it', () => {
		// The 404 guard. Inventing a rewrite for a shape nobody has measured is how a
		// picture that used to load stops loading.
		const strange = 'https://cf.bstatic.com/xdata/images/hotel/original/751028262.jpg';
		expect(upgradeBookingPhoto(strange)).toBe(strange);
		expect(upgradeBookingPhoto('https://a.hwstatic.com/propertyimages/5/527/x.jpg')).toBe(
			'https://a.hwstatic.com/propertyimages/5/527/x.jpg'
		);
	});
});

describe('originalBookingPhoto', () => {
	it('gives back the exact address the upgrade started from', () => {
		expect(originalBookingPhoto(upgradeBookingPhoto(SQUARE_60))).toBe(SQUARE_60);
	});

	it('has nothing to offer for a URL that was never upgraded', () => {
		// `undefined` is what stops a renderer retrying the same broken address forever.
		expect(originalBookingPhoto(SQUARE_60)).toBeUndefined();
		expect(originalBookingPhoto('https://a.hwstatic.com/propertyimages/5/527/x.jpg')).toBeUndefined();
	});
});
