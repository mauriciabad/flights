import { describe, expect, it } from 'vitest';
import { agodaCardPhoto, originalAgodaPhoto } from './agoda-photo';

/**
 * The measurement these two functions exist for is in `agoda-photo.ts`, and the proof that
 * the resized address really renders at the card's width is `tools/probe-agoda-image-size.mjs`.
 * What is pinned here is that the swap only ever touches a shape it recognises, and that it
 * is exactly reversible, because reversibility is the whole reason it is safe to ship
 * against four measured URLs rather than every URL Agoda holds.
 */

const STORED = 'https://pix8.agoda.net/hotelImages/417108/0/c8efa945512ccad1b821cad1055e2d28.jpg?va=1&ce=3';
const RESIZED = `${STORED}&s=800x600`;

describe('agodaCardPhoto', () => {
	it('adds the size Agoda honours and leaves the photo id and its other parameters alone', () => {
		expect(agodaCardPhoto(STORED)).toBe(RESIZED);
	});

	it('leaves a URL that has no query string at all in a shape Agoda still accepts', () => {
		const bare = 'https://pix8.agoda.net/hotelImages/417108/0/c8efa945512ccad1b821cad1055e2d28.jpg';
		expect(agodaCardPhoto(bare)).toBe(`${bare}?s=800x600`);
	});

	it('respects a size Agoda already chose rather than overwriting it', () => {
		const sized = `${STORED}&s=1024x768`;
		expect(agodaCardPhoto(sized)).toBe(sized);
	});

	it('leaves every other host untouched', () => {
		// Hostelworld and Booking both put the size in the PATH, one as a Cloudinary
		// transformation and one as a segment, and each has its own adapter. Agoda's `s` is a
		// query parameter neither host reads, so setting it here would add bytes to a URL and
		// change nothing about the picture that came back.
		const hostelworld = 'https://a.hwstatic.com/image/upload/propertyimages/5/527/x.jpg';
		expect(agodaCardPhoto(hostelworld)).toBe(hostelworld);
		const booking = 'https://cf.bstatic.com/xdata/images/hotel/square60/751028262.jpg';
		expect(agodaCardPhoto(booking)).toBe(booking);
	});

	it('hands back an unparseable address instead of throwing', () => {
		// `agoda-mapper.ts` runs `toHttpsUrl` first, so a protocol-relative URL should never
		// reach here. If one did, dropping a thumbnail beats taking the search down with it.
		expect(agodaCardPhoto('//pix8.agoda.net/hotelImages/417108/0/x.jpg')).toBe(
			'//pix8.agoda.net/hotelImages/417108/0/x.jpg'
		);
		expect(agodaCardPhoto('')).toBe('');
	});
});

describe('originalAgodaPhoto', () => {
	it('gives back the exact address the resize started from', () => {
		expect(originalAgodaPhoto(agodaCardPhoto(STORED))).toBe(STORED);
	});

	it('has nothing to offer for a URL that was never resized', () => {
		// `undefined` is what stops a renderer retrying the same broken address forever.
		expect(originalAgodaPhoto(STORED)).toBeUndefined();
		expect(originalAgodaPhoto(`${STORED}&s=1024x768`)).toBeUndefined();
		expect(originalAgodaPhoto('https://a.hwstatic.com/image/upload/x.jpg')).toBeUndefined();
	});
});
