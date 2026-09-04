/**
 * Airline logos by IATA code, so a carrier reads as a mark rather than a text chip.
 * Direct browser-to-CDN, no key, no build step, the same "no backend" shape as every
 * other provider in this app (AGENTS.md).
 *
 * ## Source
 *
 * `images.kiwi.com/airlines/{size}/{IATA}.png?default=airline.png`, the host the owner
 * named himself. PR #150 had reached for `pics.avs.io` instead; this is the same idea on
 * a better host for this particular app, for three reasons:
 *
 * 1. It is not a new third party. `providers/flights/kiwi-public.ts` is the reason the
 *    owner's own BVC to PFO route answers at all with no keys configured, so the browser
 *    already talks to Kiwi on every search. One fewer company in the request log.
 * 2. `?default=airline.png` makes the "unknown carrier" case the CDN's problem, not
 *    ours. PR #150 recorded that its host answers an invented code with a generic glyph
 *    and that telling that apart from a real small airline's logo from the outside would
 *    mean guessing at another service's internals. Here the fallback is a documented
 *    query parameter, and an unknown code (checked with `ZZ`) redirects to a 591-byte
 *    generic airline glyph rather than 404ing.
 * 3. Measured 2026-09-04 with `curl -sD -`: `FR` (Ryanair), `TP` (TAP) and `VR` (Cabo
 *    Verde Airlines, the reference itinerary's own outbound carrier) all return real
 *    PNGs, `cache-control: max-age=604800`, no `Set-Cookie`.
 *
 * As with every airline-logo source, this is a public feed for identifying a carrier, not
 * a licence grant over the airlines' trademarks. No free source offers that, and every
 * flight-search product displays these marks on the same basis. Saying so plainly rather
 * than overclaiming is the same bar issue #11 applied when it rejected `anto1/city-icons`
 * for having no licence at all.
 *
 * ## Not a tracker
 *
 * The owner turned down Travelpayouts' "Drive" affiliate script specifically because he
 * does not want trackers in this app (docs/prompts/005-ui-quality.md). This was checked
 * against that same bar before use, by measurement, not assumption:
 *
 * - The URL carries a size and an IATA code. Nothing else. `airlineLogoUrl` closes over
 *   exactly one argument, the carrier's own public code, which is already printed as
 *   plain text on the same row. No route, no dates, no traveller count, no identifier.
 * - No `Set-Cookie` on any response measured.
 * - A request carrying a forged `Referer` of this app's own results URL came back
 *   byte-identical to one with no `Referer` at all. The response depends on the URL only.
 * - `AirlineLogo.svelte` sets `referrerpolicy="no-referrer"` anyway, so this app's own
 *   page URL, which does carry origin, destination and dates in its query string, is
 *   never sent as a `Referer` regardless of what the host would do with one.
 * - An `<img>` executes nothing. This is a static, cacheable image fetch, which is a
 *   materially different surface from running a third party's JavaScript in a page that
 *   holds the user's API keys in `localStorage`.
 */

/**
 * Exported so `tests/e2e/support/providers.ts`'s mock derives its intercept pattern from
 * this same constant instead of a hardcoded copy. Issue #132 (`osrm.ts`'s
 * `OSRM_BASE_URL`) already fixed exactly this class of bug once: a test host silently
 * drifting from the real one because nothing kept them in sync.
 */
export const AIRLINE_LOGO_BASE_URL = 'https://images.kiwi.com/airlines';

/**
 * An unknown IATA code redirects through this host on its way to the generic glyph
 * (measured: `images.kiwi.com` answers `303` to `fe-resize-image.skypicker.com`, which
 * answers `303` back to `images.kiwi.com/airlines/64x64/airline.png`). The e2e network
 * guard blocks any host a test did not mock, and a redirect target is a separate host as
 * far as it is concerned, so it is named here rather than discovered by a red CI run.
 */
export const AIRLINE_LOGO_REDIRECT_HOST = 'https://fe-resize-image.skypicker.com';

/** Square, small enough for a chip-sized mark, large enough to stay crisp at 2x on a
 * phone. The CDN serves this exact size rather than scaling a larger one in the browser. */
const LOGO_SIZE_PX = 64;

export function airlineLogoUrl(iataCode: string): string {
	const code = encodeURIComponent(iataCode.trim().toUpperCase());
	return `${AIRLINE_LOGO_BASE_URL}/${LOGO_SIZE_PX}x${LOGO_SIZE_PX}/${code}.png?default=airline.png`;
}

/**
 * The fallback when the request itself does not complete: offline, blocked by an
 * extension, a timeout. Never a broken image, which is issue #11's bar for "total".
 *
 * The airline's name gives the letters, not its IATA code, because the code is already
 * printed in mono type on the same row and two copies of "FR" a centimetre apart is
 * noise. One word gives two letters ("RY" for Ryanair), two words give one each ("CV"
 * for Cabo Verde Airlines).
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
