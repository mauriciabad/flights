/**
 * The address a provider actually published, for a photograph this app asked for at a
 * different size.
 *
 * Two adapters now rewrite an image URL before it reaches a card. `booking-photo.ts`
 * upgrades a 60x60 thumbnail (#279), `agoda-photo.ts` shrinks a 2048px original (#281),
 * and each one is measured against a handful of ids rather than every id the provider
 * holds. A shape either got wrong 404s and blanks a picture, so every renderer retries
 * once at the published address and lands on the behaviour that shipped before the
 * rewrite existed.
 *
 * `PickedBed.svelte` used to call Booking's reverse directly, under a comment saying a
 * second provider wanting one would turn that call into a table. Agoda is the second, so
 * here is the table. Each reverse answers `undefined` for an address it did not write, so
 * they compose without any of them knowing about the others, and a renderer needs to know
 * about none of them.
 */

import { originalAgodaPhoto } from './agoda-photo';
import { originalBookingPhoto } from './booking-photo';

const PUBLISHED_ADDRESS = [originalAgodaPhoto, originalBookingPhoto];

/** `undefined` when nothing rewrote this URL, which a renderer reads as "this one is
 * simply broken" rather than retrying the same address forever. */
export function originalStayPhoto(url: string): string | undefined {
	for (const reverse of PUBLISHED_ADDRESS) {
		const published = reverse(url);
		if (published) return published;
	}
	return undefined;
}
