/**
 * One place that decides how a probe's browser presents itself.
 *
 * Playwright's default headless User-Agent says "HeadlessChrome". Kiwi's public endpoint
 * (providers/flights/kiwi-public.ts) answers that with a 403 carrying no CORS headers,
 * and answers an ordinary Chrome UA with a 200. A probe using the default therefore
 * reports Kiwi as FAILED on routes that work perfectly for real visitors, which is how
 * two production checks of the BVC to PFO reference route came back "0 of 0 itineraries"
 * while the same URL in a normal browser showed two.
 *
 * A checking instrument that lies is worse than no check, so every probe here shares this.
 */
export const PROBE_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** A context that looks like a person's browser. Use this instead of `browser.newContext()`. */
export function newProbeContext(browser, options = {}) {
	return browser.newContext({ userAgent: PROBE_USER_AGENT, ...options });
}
