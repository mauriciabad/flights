/**
 * The address a provider actually published, for a photograph this app asked for at a
 * different size.
 *
 * Three adapters now rewrite an image URL before it reaches a card. `booking-photo.ts`
 * upgrades a 60x60 thumbnail (#279), `agoda-photo.ts` shrinks a 2048px original (#281),
 * `hostelworld-photo.ts` sends a 2.8 MB original through Cloudinary (#284), and each one is
 * measured against a handful of ids rather than every id the provider holds. A shape any of
 * them got wrong blanks a picture, so every renderer retries once at the published address
 * and lands on the behaviour that shipped before the rewrite existed.
 *
 * Hostelworld is the sharp one. Agoda ignores an `s` it cannot read and hands back the
 * full-size photograph, so a mistake there costs bytes. Cloudinary answers 400 with an empty
 * body for a transformation it cannot parse, so there the reverse below is the only thing
 * standing between a shape nobody measured and an empty card.
 *
 * `PickedBed.svelte` used to call Booking's reverse directly, under a comment saying a
 * second provider wanting one would turn that call into a table. Agoda is the second, so
 * here is the table. Each reverse answers `undefined` for an address it did not write, so
 * they compose without any of them knowing about the others, and a renderer needs to know
 * about none of them.
 */

import { originalAgodaPhoto } from './agoda-photo';
import { originalBookingPhoto } from './booking-photo';
import { originalHostelworldPhoto } from './hostelworld-photo';

const PUBLISHED_ADDRESS = [originalAgodaPhoto, originalBookingPhoto, originalHostelworldPhoto];

/** `undefined` when nothing rewrote this URL, which a renderer reads as "this one is
 * simply broken" rather than retrying the same address forever. */
export function originalStayPhoto(url: string): string | undefined {
	for (const reverse of PUBLISHED_ADDRESS) {
		const published = reverse(url);
		if (published) return published;
	}
	return undefined;
}
