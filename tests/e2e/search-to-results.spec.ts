import { expect, test } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * The journey from a search to its results, which used to be two tabs and a person's own
 * inference. The owner: "the ux of goig from search to result makes no fucking sense. you
 * should get redirected and searches should be saved in some history and results should be
 * merged with search, you first pick the search and then shows results, they are not 2
 * separate tabs."
 *
 * Everything here is about that journey and about what the form refuses to send. The
 * search pipeline itself is covered by `results-stream-consumption.spec.ts` and
 * `result-detail.spec.ts`, so these tests deliberately do not assert on fares.
 *
 * Dates are far enough out to stay in the future for years, since one of the rules under
 * test is "a date in the past is not a search worth spending".
 */

const DEPARTURE = '2027-03-08';
const ARRIVAL = '2027-03-27';

/** BCN -> VIE -> TLL, the same chain `result-detail.spec.ts` uses, so a search run
 * here really produces a card rather than an empty board. Fixture-marked values only. */
async function mockConnectingFlights(page: import('@playwright/test').Page) {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), [
		{
			dep: 'BCN',
			arr: 'VIE',
			depDate: '2027-03-08T08:00:00',
			arrDate: '2027-03-08T10:15:00',
			price: FIXTURE_PRICES.first,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[2]
		},
		{
			dep: 'VIE',
			arr: 'TLL',
			depDate: '2027-03-10T11:00:00',
			arrDate: '2027-03-10T13:20:00',
			price: FIXTURE_PRICES.third,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
		}
	]);
}

/** The airport typeahead commits on blur, resolving a three-letter code against the
 * bundled dataset, so a code plus a Tab is how a person fills it in from the keyboard. */
async function fillAirport(page: import('@playwright/test').Page, id: string, code: string) {
	await page.locator(`#${id}`).fill(code);
	await page.locator(`#${id}`).blur();
	await expect(page.locator(`#${id}`)).toHaveValue(new RegExp(`^${code} `));
}

async function fillValidSearch(
	page: import('@playwright/test').Page,
	{ from = 'BCN', to = 'TLL' }: { from?: string; to?: string } = {}
) {
	await fillAirport(page, 'origin-airport', from);
	await fillAirport(page, 'destination-airport', to);
	await page.locator('#soonest-departure').fill(DEPARTURE);
	await page.locator('#latest-arrival').fill(ARRIVAL);
}

test.describe('search to results', () => {
	test('submitting the search goes straight to its results, with the query still on screen', async ({
		page
	}) => {
		await mockConnectingFlights(page);

		await page.goto('/');
		await fillValidSearch(page);
		await page.getByRole('button', { name: 'Search flights' }).click();

		await page.waitForURL(/\/results\/\?.*from=BCN/);
		expect(new URL(page.url()).searchParams.get('to')).toBe('TLL');

		// The search that produced the page, above the results rather than a tab away.
		const heading = page.getByRole('heading', { level: 1 });
		await expect(heading).toContainText('BCN');
		await expect(heading).toContainText('TLL');
		await expect(page.getByRole('button', { name: 'Edit search' })).toBeVisible();
	});

	test('the query above the results opens the real form, and editing it re-runs the search', async ({
		page
	}) => {
		await mockConnectingFlights(page);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		const editToggle = page.getByRole('button', { name: 'Edit search' });
		await expect(editToggle).toHaveAttribute('aria-expanded', 'false');
		await editToggle.click();

		// Prefilled from the URL that is on screen, not blank.
		await expect(page.locator('#origin-airport')).toHaveValue(/^BCN /);
		await expect(page.locator('#latest-arrival')).toHaveValue(ARRIVAL);

		await fillAirport(page, 'destination-airport', 'RIX');
		await page.getByRole('button', { name: 'Search again' }).click();

		await page.waitForURL(/to=RIX/);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('RIX');
	});

	test('a search is remembered, reachable in one tap, and removable', async ({ page }) => {
		await mockConnectingFlights(page);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('BCN');

		await page.goto('/');
		const recent = page.getByRole('link', { name: /BCN.*TLL/ });
		await expect(recent).toBeVisible();
		await expect(page.getByText('8 Mar to 27 Mar 2027')).toBeVisible();

		await recent.click();
		await page.waitForURL(/\/results\/\?.*from=BCN/);

		await page.goto('/');
		await page.getByRole('button', { name: /^Forget the search/ }).click();
		await expect(page.getByRole('link', { name: /BCN.*TLL/ })).toHaveCount(0);

		// Gone for good, not just gone from this render.
		await page.reload();
		await expect(page.getByRole('link', { name: /BCN.*TLL/ })).toHaveCount(0);
	});

	test('the chrome offers exactly two destinations, and Results is not one of them', async ({
		page
	}) => {
		// #182's rule, re-asserted against the chrome that replaced the tab bar: a search and
		// its results are one place. The bar itself is gone (two destinations did not need
		// one), so this now checks the header rather than a nav, but the claim is unchanged.
		await mockConnectingFlights(page);

		await page.goto('/');
		const header = page.getByRole('banner');
		await expect(header.getByRole('link', { name: 'Results' })).toHaveCount(0);
		await expect(header.getByRole('link')).toHaveCount(2);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		// The way back to the search is the brand, which is why Settings is the only thing
		// that ever marks itself current.
		await expect(header.getByRole('link', { name: /Layover/ })).toHaveAttribute('href', /\/$/);
		await expect(header.getByRole('link', { name: 'Settings' })).not.toHaveAttribute(
			'aria-current',
			'page'
		);

		await page.goto('/settings/');
		await expect(header.getByRole('link', { name: 'Settings' })).toHaveAttribute(
			'aria-current',
			'page'
		);
	});

	test('an old link that still carries a search on the search page redirects to its results', async ({
		page
	}) => {
		await mockConnectingFlights(page);

		await page.goto(`/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await page.waitForURL(/\/results\/\?.*from=BCN/);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('TLL');
	});
});

test.describe('validation', () => {
	test('an origin equal to the destination never leaves the form', async ({ page }) => {
		await page.goto('/');
		await fillValidSearch(page, { from: 'BCN', to: 'BCN' });
		await page.getByRole('button', { name: 'Search flights' }).click();

		await expect(
			page.getByText('BCN is also your origin. Pick somewhere else to fly to.')
		).toHaveCount(2); // once in the summary, once under the field itself
		expect(new URL(page.url()).pathname).not.toContain('results');
	});

	test('an arrival before its own departure names the date to beat', async ({ page }) => {
		await page.goto('/');
		await fillValidSearch(page);
		await page.locator('#latest-arrival').fill('2027-03-01');
		await page.getByRole('button', { name: 'Search flights' }).click();

		await expect(
			page.getByText('You cannot arrive before you leave. Pick 2027-03-08 or later.').first()
		).toBeVisible();
		expect(new URL(page.url()).pathname).not.toContain('results');
	});

	test('a date that has already passed is refused before a search is spent', async ({ page }) => {
		await page.goto('/');
		await fillValidSearch(page);
		await page.locator('#soonest-departure').fill('2020-01-01');
		await page.getByRole('button', { name: 'Search flights' }).click();

		await expect(page.getByText(/2020-01-01 has already passed/).first()).toBeVisible();
		expect(new URL(page.url()).pathname).not.toContain('results');
	});

	test('zero travellers is refused instead of silently becoming one', async ({ page }) => {
		await page.goto('/');
		await fillValidSearch(page);
		await page.locator('#travellers').fill('0');
		await page.getByRole('button', { name: 'Search flights' }).click();

		await expect(page.getByText('A trip needs at least one traveller.').first()).toBeVisible();
		expect(new URL(page.url()).pathname).not.toContain('results');
	});

	test('the error summary is focused on a failed submit and links to the field', async ({
		page
	}) => {
		await page.goto('/');
		await page.getByRole('button', { name: 'Search flights' }).click();

		const summary = page.locator('.error-summary');
		await expect(summary).toBeFocused();
		await summary.getByRole('link', { name: 'Choose the airport you are flying from.' }).click();
		await expect(page.locator('#origin-airport')).toBeFocused();
	});

	test('a results link describing an impossible trip asks no provider anything', async ({
		page
	}) => {
		await mockConnectingFlights(page);

		const providerRequests: string[] = [];
		page.on('request', (request) => {
			const url = request.url();
			if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
				providerRequests.push(url);
			}
		});

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=BCN`);
		await expect(page.getByText('This search cannot be run as it stands')).toBeVisible();
		await expect(
			page.getByText('BCN is also your origin. Pick somewhere else to fly to.').first()
		).toBeVisible();

		// Give any search that was going to start the chance to start.
		await page.waitForTimeout(1500);
		expect(providerRequests, providerRequests.join('\n')).toEqual([]);
	});
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 375, height: 812 } });

	test('the first result is on the first screen, with filters one tap away', async ({ page }) => {
		await mockConnectingFlights(page);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();
		const box = await card.boundingBox();
		// Issue #139 measured this at about 1,650px: "the third screen", behind the sort
		// control, four sliders, two chip rows and the widen panel.
		expect(box, 'the first result card should have a box').not.toBeNull();
		expect(box!.y, `first result card sat ${box!.y}px down a 812px screen`).toBeLessThan(500);

		const filterToggle = page.getByRole('button', { name: /Filter and sort/ });
		await expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
		await filterToggle.click();
		await expect(filterToggle).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByLabel('Sort by')).toBeVisible();
	});

	test('submitting from the bottom of the form still lands at the top of the results', async ({
		page
	}) => {
		await mockConnectingFlights(page);

		await page.goto('/');
		await fillValidSearch(page);
		await page.getByRole('button', { name: 'Search flights' }).click();
		await page.waitForURL(/\/results\//);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		// `.app-content` is the element that scrolls, not the document (#177), and
		// SvelteKit only ever resets the document. Without the layout's own reset this
		// measured 115px: the answer arrived already scrolled past.
		const scrollTop = await page.evaluate(
			() => document.querySelector('.app-content')?.scrollTop
		);
		expect(scrollTop, 'the results should open at the top, not where the form was').toBe(0);
	});
});
