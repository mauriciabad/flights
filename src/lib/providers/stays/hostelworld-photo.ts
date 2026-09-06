/**
 * Hostelworld publishes its photographs at full size, and #284 concluded that
 * `a.hwstatic.com` is "a dumb origin, not an image CDN". The experiment behind that
 * conclusion sent imgix-style QUERY PARAMETERS to the ORIGIN path, `/propertyimages/...`,
 * where nothing reads them. `a.hwstatic.com` is a Cloudinary account, and Cloudinary takes
 * its instructions from a path segment, `/image/upload/<transformations>/v1/<public id>`.
 *
 * Measured 2026-09-06 with curl, sending a real Chrome User-Agent and an
 * `Accept: image/avif,image/webp,...` header, against one photograph
 * (`propertyimages/3/330521/wb28ggqjivwcpqxl19oo`, written `<id>` below):
 *
 *   /propertyimages/3/330521/wb28ggqjivwcpqxl19oo.jpg  200  2,794,252  image/jpeg
 *   /image/upload/f_auto,q_auto/v1/<id>                200  1,424,980  image/webp
 *   /image/upload/c_limit,w_800,f_auto,q_auto/v1/<id>  200     99,478  image/webp
 *   /image/upload/c_limit,w_400,f_auto,q_auto/v1/<id>  200     31,072  image/webp
 *   /image/upload/zzz_bogus,w_400/v1/<id>              400          0  image/gif
 *
 * The last row is the control #284's run never had. A transformation Cloudinary cannot
 * parse is refused outright, which is how we know this path reads what it is given instead
 * of ignoring it. A byte-identical 200 could never have proved that either way.
 *
 * Across eight real photographs the shipped transformation takes 13,157,409 bytes down to
 * 523,570, or 96.0% less. Three of the eight are photographs
 * `fixtures/hostelworld-properties-*.json` carries. The other five are further real public
 * ids measured on the same day.
 *
 * ## Why 800, and what `c_limit` buys that `s=WxH` did not
 *
 * 800 is the number `agoda-photo.ts` already uses, and its `CARD_SIZE` comment holds the
 * box measurements that produced it (269 CSS px at a 375 viewport, 766 at 1280). This file
 * cites that rather than repeating it, so the two adapters cannot drift into disagreeing
 * about how wide a card photograph is.
 *
 * `c_limit` bounds the width and never upscales, so a small original is left at its own
 * size instead of being blown up to 800. `propertyimages/2/285882/34` is 600x800 stored and
 * comes back 600x800, and it still falls from 43,704 bytes to 32,248 because `f_auto`
 * re-encodes it to webp. Nothing in the table gets bigger.
 *
 * `f_auto` is safe to ask for unconditionally. Sent `Accept: image/*` with no webp offered,
 * that same address answers `image/jpeg` at 96,917 bytes, so a browser too old for webp
 * gets a smaller photograph rather than a broken one.
 *
 * ## The exact address, and why it keeps the `.jpg`
 *
 * `/v1/` and the trailing `.jpg` are both optional to Cloudinary. All four combinations
 * return 200 and the identical 99,478 bytes for the photograph above. `/v1/` is here
 * because it is the form Hostelworld itself publishes, which `imagesGallery` in
 * hostelworld-types.ts records. The extension is here because the rewrite has to be exactly
 * reversible. Carrying every character of the published path through means
 * `originalHostelworldPhoto` slices one known prefix off and is done. Dropping `.jpg` would
 * have delivered the same picture and left the reverse guessing which extension to put back.
 *
 * ## Why the reverse direction exists, and why it carries more weight here than at Agoda
 *
 * Eight photographs is not every photograph, and this failure runs the opposite way from
 * Agoda's. `agoda-photo.ts` measured that an `s` Agoda cannot parse is ignored and the
 * full-size image arrives anyway, so a size that file gets wrong costs bytes. Cloudinary
 * answers 400 with an empty body, both for a transformation it cannot parse and for a public
 * id it does not hold, so a shape THIS file gets wrong blanks the picture.
 *
 * The rewrite therefore degrades instead of failing. Whatever renders a delivery address
 * asks `originalHostelworldPhoto` for the one Hostelworld published and retries there once,
 * landing on the full-size photograph that shipped before this file existed.
 *
 * Both directions live in this one file so they cannot drift into disagreeing about where
 * the transformation lives.
 */

/** Hostelworld's image host, and the only host this file will touch. Narrow on purpose, for
 * the reason `agoda-photo.ts` gives about its own `pix*` family. The rewrite has been
 * measured against this host alone, and inventing a transformation for a host it has never
 * seen is how a blanked picture gets in. Compared against `URL.hostname`, which the parser
 * has already lowercased, so nothing here folds case. */
const IMAGE_HOST = 'a.hwstatic.com';

/** Every Cloudinary delivery address on this host begins here, whatever transformation
 * follows. A path already under it is Hostelworld having chosen a transformation of its own
 * (its website serves `f_auto,q_auto,t_40/...`), which is a decision to respect. */
const DELIVERY_ROOT = '/image/upload/';

const CARD_PREFIX = `${DELIVERY_ROOT}c_limit,w_800,f_auto,q_auto/v1`;

function parseHostelworldImageUrl(url: string): URL | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// hostelworld-mapper.ts builds these by prepending `https://` to a host, so an
		// unparseable one should not arrive. If one did, dropping a thumbnail beats taking
		// the whole search down with it.
		return undefined;
	}
	return parsed.hostname === IMAGE_HOST ? parsed : undefined;
}

/**
 * The card-sized address for a Hostelworld photograph. A URL on another host, one that
 * cannot be parsed, and one already under `/image/upload/` all come back untouched. The
 * last of those is the same rule `agodaCardPhoto` applies to an `s` Agoda already set, and
 * it is what makes this safe to run twice over the same address.
 */
export function hostelworldCardPhoto(url: string): string {
	const parsed = parseHostelworldImageUrl(url);
	if (!parsed || parsed.pathname.startsWith(DELIVERY_ROOT)) return url;
	parsed.pathname = CARD_PREFIX + parsed.pathname;
	return parsed.toString();
}

/**
 * The address `hostelworldCardPhoto` started from, or `undefined` for a URL this file did
 * not write, which therefore has nothing to fall back to. A renderer reads `undefined` as
 * "this one is simply broken" rather than retrying the same address forever.
 */
export function originalHostelworldPhoto(url: string): string | undefined {
	const parsed = parseHostelworldImageUrl(url);
	// The trailing slash is the segment boundary, and it is load-bearing. Without it
	// `/v1extra/x.jpg` matches the prefix and slices down to `https://a.hwstatic.com/extra/x.jpg`,
	// and a path that is exactly the prefix slices down to the bare host. Both are addresses
	// nothing published, and handing one back is worse than answering `undefined`, because a
	// renderer retries what it is given and only stops at `undefined`.
	if (!parsed || !parsed.pathname.startsWith(`${CARD_PREFIX}/`)) return undefined;
	parsed.pathname = parsed.pathname.slice(CARD_PREFIX.length);
	return parsed.toString();
}
