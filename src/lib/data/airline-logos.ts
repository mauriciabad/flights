/**
 * Issue #119: airline logos by IATA code, so a carrier reads as a mark rather than a text
 * chip. Direct browser-to-CDN, no key, no build step — same "no backend" shape as every
 * other provider in this app (AGENTS.md).
 *
 * ## Source and licence
 *
 * `pics.avs.io/{width}/{height}/{iataCode}.png` is Aviasales' own documented logo feed
 * (Travelpayouts support centre, "Airline logos by Aviasales":
 * https://support.travelpayouts.com/hc/en-us/articles/203956073), published specifically
 * for partner sites building flight-search UIs — this app's exact situation. Verified
 * 2026-09-04 with a direct `curl -sI`: every request answered `access-control-allow-origin:
 * *` (served off CloudFront, `s-maxage=31536000`), and real logos came back for a
 * mainstream carrier (`FR`, Ryanair), a national flag carrier (`TP`, TAP Portugal) and a
 * small regional one (`VR`, Cabo Verde Airlines — the reference itinerary's own outbound
 * carrier). Travelpayouts' pricing API was already ruled out elsewhere in this codebase for
 * sending no CORS headers at all (docs/PROVIDERS.md); this is a different host serving
 * static images, which is why the CORS story is different and was re-checked from scratch
 * rather than assumed from that earlier finding.
 *
 * This is a publicly documented feed meant for exactly this kind of embedding, not a
 * license grant to the airlines' own trademarks — no source of free airline logos offers
 * that, and every flight-search product (Skyscanner, Kayak, Google Flights) displays these
 * same marks on the same basis: identifying the carrier, not claiming rights to its brand.
 * `anto1/city-icons` was rejected in issue #11 for having no licence file at all (GitHub's
 * API reports `license: null`); this is not that situation — the feed is documented for
 * third-party use — but it is also not a formal open-source grant, and the PR for this
 * change says so plainly rather than overclaiming.
 *
 * A code this feed has never heard of still answers 200 with a generic placeholder glyph
 * (verified against a handful of invented codes) rather than a 404 — this module makes no
 * attempt to detect and replace that specific case, since telling "a real small airline's
 * logo" from "the feed's own placeholder" from the outside would mean guessing at another
 * service's internal behaviour. `AirlineLogo.svelte`'s `onerror` fallback instead handles
 * the failure this app can actually observe: the request itself not completing (offline,
 * blocked by an extension, a timeout) — issue #11's own bar for "total": never a broken
 * image, always something.
 *
 * ## Not a tracker
 *
 * The owner turned down Travelpayouts' "Drive" affiliate script specifically because he does
 * not want trackers in this app (docs/prompts/005-ui-quality.md). This is a different
 * surface from that script and was checked against the same bar before use:
 *
 * - The URL carries only a width, a height and an IATA code — no `marker` parameter, no
 *   session id, no affiliate slot exists in this feed's path shape at all (unlike a
 *   Travelpayouts booking link, which is how that program actually attributes anything).
 *   It works identically with or without a Travelpayouts account behind it.
 * - Checked with `curl -sD -`: the response carries no `Set-Cookie` header, and a request
 *   with a fake `Referer` came back byte-identical (a plain CloudFront cache hit,
 *   `x-cache: Hit from cloudfront`) to one without — the response depends only on the URL,
 *   nothing about the request answers differently based on who's asking or where from.
 * - `AirlineLogo.svelte`'s `<img>` also sets `referrerpolicy="no-referrer"` directly, so this
 *   app's own page URL (route, dates, anything in the query string) is never sent even as a
 *   `Referer` header, on top of the feed not using one anyway.
 * - Nothing this module builds ever carries the traveller's search: `airlineLogoUrl` closes
 *   over exactly one argument, the airline's own public IATA code — the same fact already
 *   printed as plain text on every one of this app's own tickets, not something scoped to
 *   this search or this user.
 */

// Exported so tests/e2e/support/providers.ts's mock can derive its intercept pattern from
// this same constant instead of a hardcoded copy — issue #132 (`osrm.ts`'s `OSRM_BASE_URL`)
// already fixed exactly this class of bug once, a test host silently drifting from the real
// one because nothing kept them in sync.
export const AIRLINE_LOGO_BASE_URL = 'https://pics.avs.io';

// Square, small enough for a chip-sized mark, large enough to stay crisp at 2x on a phone.
const LOGO_SIZE_PX = 64;

export function airlineLogoUrl(iataCode: string): string {
	const code = encodeURIComponent(iataCode.trim().toUpperCase());
	return `${AIRLINE_LOGO_BASE_URL}/${LOGO_SIZE_PX}/${LOGO_SIZE_PX}/${code}.png`;
}

/**
 * The styled-monogram fallback issue #119 asks for: the airline name's first letter (or
 * two, for a name that reads as two words like "Cabo Verde"), since a bare IATA code inside
 * a badge would collide visually with the IATA code already printed in mono type right next
 * to it on every one of these chips.
 */
export function airlineMonogram(name: string): string {
	const words = name
		.trim()
		.split(/\s+/)
		.filter((word) => word.length > 0);
	if (words.length === 0) return '?';
	if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
	return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
