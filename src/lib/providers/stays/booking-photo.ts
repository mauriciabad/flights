/**
 * Booking's search rows carry one photo, and they carry it at the wrong size.
 *
 * `main_photo_url` points at the `square60` variant. Measured 2026-09-05 with
 * `tools/probe-images.mjs` against `booking-search-vienna.json`'s three photo ids: every
 * one is 60x60, 1682 bytes. That is a favicon. Stretched across a card it is a blurred
 * square, which is a worse answer than the line of text it replaced.
 *
 * The size is a path segment, not a query parameter, and swapping it serves the same
 * photograph larger. Same three ids, same run: `max1024x768` returned 1024x768 / 76,385
 * bytes, 768x768 / 71,281 and 512x768 / 44,946, all `200 image/jpeg`. `max500` also
 * works, at 500x375 / 23,898. `max1024x768` is the one taken, because the card's media
 * box is 343px wide on a 375px phone and a 2x screen wants more than 500 across.
 *
 * Note the shapes differ: `max1024x768` is a bounding box, not a crop, so one property's
 * photo is landscape and the next is square. Whatever renders these has to impose its own
 * aspect ratio rather than inherit the file's.
 *
 * ## Why the reverse direction exists
 *
 * Three ids is not every id. A shape this function does not expect, or a photo Booking
 * stores at one size only, would 404 and blank the picture, and a provider that needs a
 * key is one this repo cannot cheaply re-measure. So the rewrite degrades instead of
 * failing: whatever renders an upgraded URL asks `originalBookingPhoto` for the address it
 * came from and retries once. The worst case is then the 60px thumbnail Booking actually
 * gave us, which is exactly today's behaviour, rather than an empty box.
 *
 * Both directions live in this one file so they cannot drift into disagreeing about where
 * the size segment is.
 */

const THUMBNAIL_SEGMENT = '/square60/';
const CARD_SEGMENT = '/max1024x768/';

/**
 * The card-sized address for a Booking photo. A URL without the thumbnail segment is
 * returned untouched: this only knows how to move one known segment, and inventing a
 * rewrite for a shape it has never seen is how the 404 this guards against gets in.
 */
export function upgradeBookingPhoto(url: string): string {
	if (!url.includes(THUMBNAIL_SEGMENT)) return url;
	return url.replace(THUMBNAIL_SEGMENT, CARD_SEGMENT);
}

/**
 * The address `upgradeBookingPhoto` started from, or `undefined` when this URL was never
 * upgraded and so has nothing to fall back to. A renderer treats `undefined` as "this one
 * is simply broken" rather than retrying the same URL forever.
 */
export function originalBookingPhoto(url: string): string | undefined {
	if (!url.includes(CARD_SEGMENT)) return undefined;
	return url.replace(CARD_SEGMENT, THUMBNAIL_SEGMENT);
}
