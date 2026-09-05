/**
 * Agoda stores its photographs far larger than any screen in this app shows them, and
 * `pix*.agoda.net` will resize them on request.
 *
 * Measured 2026-09-05 with `tools/probe-agoda-image-size.mjs`, which renders real `<img>`
 * tags from an http origin and reads `naturalWidth` back, against the five `pix8` photo
 * URLs in `fixtures/agoda-search-vienna.json`. As stored they arrive at 2048x1536,
 * 1620x1080, 1920x1280, 2048x1365 and 2048x1365, costing 1,742,997 bytes between them.
 * With `s=800x600` the same five come back 800 across for 326,074 bytes: 81.3% less, 5.3x.
 *
 * `s` really is the parameter doing that, not a coincidence: a control run sent
 * `zzz=600x400` on the same photograph and got back a byte-identical 1620x1080 / 349,267.
 * An `s` Agoda cannot parse (`s=notasize`) is ignored rather than refused. It answered 200
 * with the full-size image, so a size this file got wrong would cost bytes rather than blank
 * a card. That is a floor under the failure, not a substitute for the fallback below.
 *
 * The same fixture also carries photographs hosted by Booking (`bstatic.com`, already
 * served at `max500`). `AGODA_IMAGE_HOST` leaves those untouched: they are #279's to move.
 *
 * ## Why 800x600 and not something smaller
 *
 * `s=WxH` is a bounding box that preserves aspect ratio, so the delivered width is
 * `min(W, H * sourceAspect)`. Agoda's photographs are 3:2 and 4:3, both wider than
 * 800/600, so every one of the five lands at exactly 800 across.
 *
 * 800 is the number because the card's media box was measured in the built app at four
 * viewports: 269 CSS px wide at 375, 662 at 768, and 766 at both 1280 and 1600, where the
 * page's 72rem max width caps it. `StayPicker.svelte` renders that box `object-fit: cover`
 * at 16/9, and every source here is taller than 16/9, so cover matches the box's WIDTH and
 * crops the height. Only the delivered width matters. 800 covers the widest box the card
 * ever draws. The `s=600x400` the issue suggested delivers 533-600 across, which is a
 * visible upscale in a 766px box, and it saves only another ~20 KB per photograph.
 *
 * ## Why the reverse direction exists
 *
 * Five URLs is not every URL. Agoda serves images from several `pix*` hosts and this
 * adapter needs a key to re-measure, so a shape that answers `s` differently from these
 * five would blank the picture rather than merely being large. The rewrite therefore
 * degrades instead of failing: whatever renders a resized URL asks `originalAgodaPhoto`
 * for the address it came from and retries once. The worst case is then the full-size
 * photograph Agoda actually gave us, which is exactly today's behaviour.
 *
 * Both directions live in this one file so they cannot drift into disagreeing about where
 * the size lives.
 */

const SIZE_PARAM = 's';
const CARD_SIZE = '800x600';

/** Agoda's image CDN hosts, `pix1.agoda.net` through `pix*.agoda.net`. The fixtures all
 * sit on `pix8`. Narrow on purpose: this rewrite has only been measured
 * against this host family, and inventing one for a host it has never seen is how a
 * blanked picture gets in. */
const AGODA_IMAGE_HOST = /^pix\d+\.agoda\.net$/i;

function parseAgodaImageUrl(url: string): URL | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// A protocol-relative or otherwise unparseable address. `agoda-mapper.ts` runs
		// `toHttpsUrl` first so this should not happen, but a throw here would take down the
		// whole search rather than lose one thumbnail.
		return undefined;
	}
	return AGODA_IMAGE_HOST.test(parsed.hostname) ? parsed : undefined;
}

/**
 * The card-sized address for an Agoda photograph. A URL on another host, or one that
 * already carries its own `s`, is returned untouched: Agoda choosing a size itself is a
 * decision to respect, not one to overwrite.
 */
export function agodaCardPhoto(url: string): string {
	const parsed = parseAgodaImageUrl(url);
	if (!parsed || parsed.searchParams.has(SIZE_PARAM)) return url;
	parsed.searchParams.set(SIZE_PARAM, CARD_SIZE);
	return parsed.toString();
}

/**
 * The address `agodaCardPhoto` started from, or `undefined` when this URL was never
 * resized and so has nothing to fall back to. A renderer treats `undefined` as "this one
 * is simply broken" rather than retrying the same address forever.
 */
export function originalAgodaPhoto(url: string): string | undefined {
	const parsed = parseAgodaImageUrl(url);
	if (!parsed || parsed.searchParams.get(SIZE_PARAM) !== CARD_SIZE) return undefined;
	parsed.searchParams.delete(SIZE_PARAM);
	const original = parsed.toString();
	return original === url ? undefined : original;
}
