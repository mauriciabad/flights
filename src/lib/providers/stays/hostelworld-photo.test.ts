import { describe, expect, it } from 'vitest';
import { hostelworldCardPhoto, originalHostelworldPhoto } from './hostelworld-photo';

/**
 * The measurement these two functions exist for is in `hostelworld-photo.ts`. What is
 * pinned here is that the rewrite only ever touches a shape it recognises, and that it is
 * exactly reversible, because reversibility is the whole reason it is safe to ship against
 * eight measured photographs rather than every photograph Hostelworld holds. It carries
 * more weight than the same pinning does for Agoda: Cloudinary answers 400 for anything it
 * cannot parse, so an unrecognised shape blanks a card instead of merely costing bytes.
 */

/** London Backpackers' first photograph in `fixtures/hostelworld-properties-london.json`,
 * as Hostelworld publishes it. 984,293 bytes at this address, 72,084 at the one below. */
const PUBLISHED = 'https://a.hwstatic.com/propertyimages/5/527/hcfi2krbq0sja1spk7pi.jpg';
const DELIVERED =
	'https://a.hwstatic.com/image/upload/c_limit,w_800,f_auto,q_auto/v1/propertyimages/5/527/hcfi2krbq0sja1spk7pi.jpg';

describe('hostelworldCardPhoto', () => {
	it('asks Cloudinary for the card width and carries the public id through character for character', () => {
		expect(hostelworldCardPhoto(PUBLISHED)).toBe(DELIVERED);
	});

	it('respects a transformation Hostelworld already chose rather than stacking one on top', () => {
		// Hostelworld's own website serves this named transformation, and running twice over
		// an address this file already wrote is the same case.
		const website =
			'https://a.hwstatic.com/image/upload/f_auto,q_auto,t_40/propertyimages/1/14348/bal7l15984pdvbwv5vkb.jpg';
		expect(hostelworldCardPhoto(website)).toBe(website);
		expect(hostelworldCardPhoto(DELIVERED)).toBe(DELIVERED);
	});

	it('leaves every other host untouched', () => {
		// Agoda's size is a query parameter and Booking's is a path segment, both handled by
		// their own adapters. A Cloudinary transformation means nothing on either host, and
		// prefixing one would 404 a photograph that loads today.
		const agoda = 'https://pix8.agoda.net/hotelImages/417108/0/c8efa945512ccad1b821cad1055e2d28.jpg';
		expect(hostelworldCardPhoto(agoda)).toBe(agoda);
		const booking = 'https://cf.bstatic.com/xdata/images/hotel/square60/751028262.jpg';
		expect(hostelworldCardPhoto(booking)).toBe(booking);
	});

	it('hands back an unparseable address instead of throwing', () => {
		// hostelworld-mapper.ts prepends `https://`, so a protocol-relative address should
		// never reach here. If one did, dropping a thumbnail beats taking the search down.
		expect(hostelworldCardPhoto('//a.hwstatic.com/propertyimages/5/527/x.jpg')).toBe(
			'//a.hwstatic.com/propertyimages/5/527/x.jpg'
		);
		expect(hostelworldCardPhoto('')).toBe('');
	});
});

describe('originalHostelworldPhoto', () => {
	it('gives back the exact address the rewrite started from', () => {
		expect(originalHostelworldPhoto(DELIVERED)).toBe(PUBLISHED);
		expect(originalHostelworldPhoto(hostelworldCardPhoto(PUBLISHED))).toBe(PUBLISHED);
	});

	it('has nothing to offer for a URL this file did not write', () => {
		// `undefined` is what stops a renderer retrying the same broken address forever.
		expect(originalHostelworldPhoto(PUBLISHED)).toBeUndefined();
		expect(
			originalHostelworldPhoto(
				'https://a.hwstatic.com/image/upload/f_auto,q_auto,t_40/propertyimages/1/14348/x.jpg'
			)
		).toBeUndefined();
		expect(
			originalHostelworldPhoto('https://pix8.agoda.net/hotelImages/417108/0/x.jpg?s=800x600')
		).toBeUndefined();
	});

	it('refuses to invent an address from a path that merely starts like one of ours', () => {
		// The reverse is the only thing between a Cloudinary 400 and an empty card, so it has
		// to answer `undefined` rather than a plausible-looking address a renderer would then
		// retry. Matching the prefix without the segment boundary turned the first of these
		// into `https://a.hwstatic.com/extra/x.jpg` and the second into the bare host.
		expect(
			originalHostelworldPhoto(
				'https://a.hwstatic.com/image/upload/c_limit,w_800,f_auto,q_auto/v1extra/x.jpg'
			)
		).toBeUndefined();
		expect(
			originalHostelworldPhoto('https://a.hwstatic.com/image/upload/c_limit,w_800,f_auto,q_auto/v1')
		).toBeUndefined();
	});
});
