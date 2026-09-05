import { test, expect } from './support/fixtures';
import { mockAllKeylessProviders } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #130. On the owner's reference route (BVC to PFO) Ryanair answered twice, both
 * times `404`, which is how that endpoint says an airport is not on its network. The page
 * reported "Nothing has answered yet" and then blamed "no workable connection", sending the
 * traveller off to change their destination over a provider that does not fly out of Cabo
 * Verde at all.
 *
 * Unit tests cover the wording (`results/no-results.test.ts`) and the counters
 * (`search/provenance.test.ts`). What only a real browser can prove is the part that
 * actually broke: that a provider answering with nothing reaches the page as its own
 * visible state, distinct from never having answered. Issue #87 is the standing reminder
 * that this class of bug survives a green unit suite.
 *
 * How "not on Ryanair's network" arrives changed with issue #121, but the fact being
 * tested did not. The adapter no longer asks
 * `/views/locate/searchWidget/routes/en/airport/{IATA}` and no longer receives that
 * endpoint's `404`; it reads the whole route graph off the active-airports response, where
 * an airport Ryanair does not serve is simply absent. `mockAllKeylessProviders`'s fixture
 * lists neither BVC nor PFO, which is the same statement the two `404`s made — so this
 * still reproduces a provider answering, with nothing, rather than a missing mock.
 *
 * Keyless providers only: no Agoda or Booking request is made or mocked here.
 */
test.describe('providers that answer with nothing (issue #130)', () => {
	test('an airport outside Ryanair’s network reads as answered-with-nothing, never as silence', async ({
		page
	}) => {
		await mockAllKeylessProviders(page.context());

		// The issue's own URL. BCN would not reproduce it: the bundled fallback route table
		// covers Barcelona, so candidates survive, fares get fetched, and Ryanair ends the
		// search having answered with data. BVC is the case where the route graph is the
		// entire search.
		await page.goto('/results/?dep=2026-10-06&arr=2026-10-12&from=BVC&to=PFO');
		await waitForSearchToSettle(page, { timeout: 15_000 });

		// The first lie: Ryanair answered, so the strip must not claim nothing was called.
		const ryanair = page.locator('[data-testid="provider-status"][data-provider="ryanair"]');
		await expect(ryanair).toBeVisible();
		await expect(ryanair).toHaveAttribute('data-answer', 'nothing-found');
		await expect(page.getByTestId('provider-strip-empty')).toHaveCount(0);
		// Requests were really spent, and the strip says how many. A regex rather than the
		// literal "reqs", because the strip correctly writes "1 req" and the whole point of
		// issue #121 is that this scenario now costs exactly one request: the route graph
		// arrives for the entire network at once instead of once per airport.
		await expect(ryanair).toContainText(/\d+\s*reqs?\b/);

		// The second lie: the empty state must name what happened rather than assert a cause.
		const board = page.getByTestId('no-results-board');
		await expect(board).toBeVisible();
		await expect(board).toHaveAttribute('data-cause', 'no-route-known');
		await expect(board).not.toContainText('workable connection');
		await expect(board).not.toContainText('different destination');

		// The same provider, same verdict, in the explanation itself.
		await expect(
			board.locator('[data-testid="no-results-source"][data-provider="ryanair"]')
		).toHaveAttribute('data-answer', 'nothing-found');

		// And a way out that this search could actually take: a keyed provider it never asked.
		const fix = page.getByTestId('no-results-fix');
		await expect(fix).toBeVisible();
		await expect(fix).toHaveAttribute('href', /\/settings\/#/);
	});

	test('a provider that did answer with routes is reported differently', async ({ page }) => {
		await mockAllKeylessProviders(page.context());

		await page.goto('/results/?dep=2026-10-01&arr=2026-10-20&from=BCN&to=TLL');
		await waitForSearchToSettle(page, { timeout: 15_000 });

		// Same route, same page, only the provider's answer differs — which is the whole
		// distinction issue #130 says a traveller must be able to see.
		await expect(page.locator('[data-testid="provider-status"][data-provider="ryanair"]')).toHaveAttribute(
			'data-answer',
			'answered'
		);
	});
});
