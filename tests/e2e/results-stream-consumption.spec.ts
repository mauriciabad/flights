import { test, expect } from './support/fixtures';
import { mockAllKeylessProviders } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Regression coverage for issue #87: a real search on the results page never returned
 * anything. `stream-order.test.ts` and friends already proved cards don't reorder once
 * they arrive — nothing proved the stream from `runSearch` (`$lib/search`) was ever
 * consumed at all, which is exactly the gap that let the actual bug ship with 849 green
 * unit tests.
 *
 * The bug: `+page.svelte`'s search `$effect` called `consumeSearch(...)` without
 * `await`, so `consumeSearch`'s synchronous prologue (`searchesInFlight += 1`, a read
 * then a write of the same `$state`) ran on the effect's own call stack. Svelte tracks
 * an effect's dependencies by call stack, not lexical scope, so that read+write counted
 * as the effect reading and writing its own dependency — it retriggered itself forever,
 * tripping `effect_update_depth_exceeded` before a single snapshot ever reached the
 * page. The fix wraps the call in `untrack`. This test would fail against the
 * unfixed component: a looping effect never reaches "search finished", no matter how
 * long the test waits, and the console fills with the same error the issue reported.
 *
 * This test cannot assert a result CARD renders. Doing so surfaced a second, separate,
 * pre-existing bug (#94, not fixed here per AGENTS.md's "open an issue rather than fixing
 * it in your PR"): `buildItineraries` (`$lib/algorithm/build.ts`)
 * requires a resolved `Stay` for every candidate connection city, but neither registered
 * `StayProvider` (Agoda, Booking) is keyless, and `runCostAwareSearch`
 * (`$lib/providers/budget/cost-aware-search.ts`) only ever runs a `'metered'`-tier
 * source when it is named in `widenTo` — which `pipeline.ts` never does for stays, on
 * the free tier OR the confirm tier ("Stay and transfer resources keep using free
 * providers only, same as the free tier", its own scope note). So no itinerary can
 * currently be built at all, with any key, on any query — a search legitimately ends at
 * "no itineraries found" today. What this test asserts instead is the actual claim
 * issue #87 makes: the free tier's real, keyless providers (Ryanair, Transitous, OSRM)
 * get called and their answers reach the page, and the search reaches a finished state
 * rather than hanging on its initial skeleton forever.
 */
test.describe('results: issue #87 regression (search stream must be consumed)', () => {
	test('a real search runs its free providers to completion with zero console errors', async ({ page }) => {
		await mockAllKeylessProviders(page.context());

		const consoleErrors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});
		const pageErrors: string[] = [];
		page.on('pageerror', (error) => pageErrors.push(error.message));

		await page.goto('/results/?dep=2026-10-01&arr=2026-10-20&from=BCN&to=TLL');

		await expect(page.locator('h1')).toContainText('BCN');
		await expect(page.locator('h1')).toContainText('TLL');

		// The actual regression check: an effect stuck in `effect_update_depth_exceeded`
		// never reaches a settled search, no matter how long this waits.
		//
		// Issue #337: this line used to wait for the words "still searching" to be absent,
		// which the frozen page it guards against satisfies perfectly — #87's symptom was a
		// page that rendered nothing at all. The guard was passing on the failure it exists
		// to catch. `settled` comes from a snapshot carrying `done`, so it cannot.
		await waitForSearchToSettle(page, { timeout: 15_000 });

		// Ryanair is free and keyless — its plate appearing at all proves the stream was
		// genuinely drained into `providerStatuses`, not merely started and abandoned.
		//
		// Addressed by id and state rather than by its visible sentence (issue #130): the
		// prose used to be the only thing to match on, it now appears in two legitimate
		// places (the strip and the empty-results board), and this issue's whole subject is
		// rewording it. A test that breaks on every copy change is a test nobody trusts.
		const ryanair = page.locator('[data-testid="provider-status"][data-provider="ryanair"]');
		await expect(ryanair).toBeVisible();
		await expect(ryanair).toHaveAttribute('data-answer', 'answered');

		expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([]);
		expect(consoleErrors, `console errors: ${consoleErrors.join('; ')}`).toEqual([]);
	});
});
