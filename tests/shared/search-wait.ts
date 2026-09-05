import { expect, type Page } from '@playwright/test';

/**
 * Waiting for the results page's search, for both suites. Issue #337.
 *
 * ## What was here before
 *
 * Every spec that needed a finished search wrote this:
 *
 * ```ts
 * await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
 * ```
 *
 * `toHaveCount(0)` is satisfied by absence, and that text is absent on a page that has not
 * started searching for exactly the same reason it is absent on one that has finished.
 * There is no state in the assertion. Measured on `origin/main`, ten runs, one worker, on
 * the fixture `results-layout.spec.ts` uses: nine returned between 28ms and 40ms with zero
 * `.result-card` on screen, and the first card arrived at about 3.83 seconds. The tenth
 * caught the indicator for real. Which way a run goes is luck.
 *
 * What follows such a wait usually auto-retries, so the hole is covered by the NEXT line's
 * own timeout rather than by the 20 seconds the author asked for — which is why these
 * specs pass on a quiet laptop and fail under CI contention. Anything that does not
 * auto-retry (a count, a bounding box, a request tally) reads a page mid-flight.
 *
 * ## What replaces it
 *
 * `data-search-phase` on `.results-page`, and this waits for `settled`. The page sets that
 * from `primarySearchDone`, which is only ever written from a snapshot carrying `done`, so
 * a page that has not run a search cannot satisfy it. The wait is positive: it asks for
 * evidence the search happened, not for a string to be missing.
 *
 * `guard.spec.ts` fails the suite if a spec goes back to waiting on the text.
 */
export async function waitForSearchToSettle(
	page: Page,
	options: { timeout?: number } = {}
): Promise<void> {
	await expect(page.locator('[data-search-phase]')).toHaveAttribute(
		'data-search-phase',
		'settled',
		{ timeout: options.timeout ?? 20_000 }
	);
}
