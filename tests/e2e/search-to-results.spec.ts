import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * What the results page has actually filed, read from the key the store owns. Issue #358:
 * the `<h1>` appearing is not evidence of that write. The heading is rendered straight from
 * the URL while the write happens in an effect once the search has been validated, so a
 * spec that navigated away on the heading was racing a write that had not happened — the
 * same shape as #337, where a wait that was not evidence let a suite pass over a page that
 * had not started searching.
 */
async function filedSearches(page: import('@playwright/test').Page): Promise<string> {
	return (await page.evaluate(() => localStorage.getItem('flights.searchHistory.v1'))) ?? '';
}

/**
 * The built chunk holding `airports.generated.json`, found by its first row: its name is a
 * content hash and changes with every build. Resolved on first use rather than at import,
 * because Playwright loads this file to collect its tests before `webServer` has run
 * `pnpm build`, and a clean checkout has no `build/` to read yet.
 */
let airportDatasetChunk: string | undefined;
function findAirportDatasetChunk(): string {
	if (airportDatasetChunk) return airportDatasetChunk;
	const chunkDir = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		'..',
		'..',
		'build',
		'app',
		'immutable',
		'chunks'
	);
	airportDatasetChunk = readdirSync(chunkDir).find((file) =>
		readFileSync(path.join(chunkDir, file), 'utf-8').slice(0, 400).includes('"iataCode"')
	);
	if (!airportDatasetChunk) throw new Error(`No airports dataset chunk in ${chunkDir}.`);
	return airportDatasetChunk;
}

/**
 * Serves the airports dataset `delayMs` late, so the window in which the page knows the
 * search but not whether its airports are real is wide enough to assert against.
 *
 * Delays and then continues, rather than fetching the chunk to recognise it by its body: a
 * `route.fetch` whose page navigates away mid-delay throws "Response has been disposed" and
 * fails the test for a reason that has nothing to do with what it asserts. That cost seven
 * of twenty runs while this was being measured.
 */
async function holdBackAirportDataset(page: import('@playwright/test').Page, delayMs: number) {
	await page.context().route(`**/${findAirportDatasetChunk()}`, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		await route.continue().catch(() => {
			// The page that asked for it is gone. Nothing to serve and nothing wrong.
		});
	});
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

	test('a search is filed without waiting for the airport dataset', async ({ page }) => {
		// Issue #358. Nothing here is asked of the airports dataset: whether BCN and TLL are
		// real is a different question from whether somebody searched them, and the traveller
		// who opens a results link and immediately switches tabs used to lose the search
		// because the app was still answering the first question. Ten seconds of held-back
		// dataset against a five-second poll, so passing means the write did not wait for it.
		await mockConnectingFlights(page);
		await holdBackAirportDataset(page, 10_000);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('BCN');
		await expect.poll(() => filedSearches(page), { timeout: 5_000 }).toContain('from=BCN');
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

/**
 * Issue #351: the history, reachable from a results page rather than only from the empty
 * one. The owner: "Apart from 'Edit search' i shoudl be able to pick one from the history
 * when a result is already open."
 *
 * The history is seeded into `localStorage` rather than run twice. Recording is already
 * covered above, and what these tests are about is what the list does once it is beside
 * its own results: which row is a destination, which row is the page you are reading, and
 * whether looking at either costs you the results underneath.
 */

const CURRENT_QUERY = `arr=${ARRIVAL}&dep=${DEPARTURE}&from=BCN&to=TLL`;
const OTHER_QUERY = `arr=${ARRIVAL}&dep=${DEPARTURE}&from=BCN&to=RIX`;

/** Normalised the way `normalizeQuery` writes them: params sorted by key, so a seeded
 * entry is the same string the results page derives from the URL on screen. Getting this
 * wrong would leave the current search unmarked and the tests below would say so. */
async function seedHistory(page: import('@playwright/test').Page, queries: string[]) {
	await page.addInitScript(
		([key, entries]: [string, string[]]) => {
			window.localStorage.setItem(
				key,
				JSON.stringify(entries.map((query, index) => ({ query, lastRunAt: 1_700_000_000_000 - index })))
			);
		},
		['flights.searchHistory.v1', queries] as [string, string[]]
	);
}

test.describe('the history is reachable with results on screen', () => {
	test('the editor offers the other searches and marks the one already on screen', async ({
		page
	}) => {
		await mockConnectingFlights(page);
		await seedHistory(page, [CURRENT_QUERY, OTHER_QUERY]);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		const editor = page.locator('#search-editor');
		await expect(
			editor.getByRole('heading', { name: 'Or pick up a recent search' }),
			'the history belongs to the panel, not to the collapsed strip'
		).toBeHidden();

		await page.getByRole('button', { name: 'Edit search' }).click();
		await expect(editor.getByRole('heading', { name: 'Or pick up a recent search' })).toBeVisible();

		// The other search is somewhere to go.
		await expect(editor.getByRole('link', { name: /BCN.*RIX/ })).toBeVisible();
		// The one on screen is not. A link back to the page it is printed on is a dead end,
		// so that row is a label, and it says which one it is.
		await expect(editor.getByRole('link', { name: /BCN.*TLL/ })).toHaveCount(0);
		const here = editor.locator('[aria-current="true"]');
		await expect(here).toContainText('TLL');
		await expect(here).toContainText('On screen now');
		// Nor can you throw away the search you are reading, which the page would re-file on
		// the next load anyway.
		await expect(editor.getByRole('button', { name: /^Forget the search BCN to TLL/ })).toHaveCount(0);
	});

	test('opening the history keeps the results and their picked state underneath', async ({
		page
	}) => {
		// #311's rule, applied here: a traveller may have picked a bed, nudged a waiting time
		// and swapped a flight, and none of that is in the URL. So the marker below is put on
		// the live card element itself. If the panel re-ran the search or tore the list down,
		// the card carrying it would be gone and this would fail.
		await mockConnectingFlights(page);
		await seedHistory(page, [CURRENT_QUERY, OTHER_QUERY]);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await waitForSearchToSettle(page, { timeout: 20_000 });
		const url = page.url();

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();
		await card.evaluate((element) => element.setAttribute('data-survived', 'yes'));

		await page.getByRole('button', { name: 'Edit search' }).click();
		await expect(page.locator('#search-editor').getByRole('link', { name: /BCN.*RIX/ })).toBeVisible();

		await expect(
			page.locator('.result-card[data-survived="yes"]'),
			'the card the traveller was reading was rebuilt'
		).toHaveCount(1);
		await expect(page.locator('[data-search-phase]')).toHaveAttribute('data-search-phase', 'settled');
		expect(page.url(), 'looking at the history is not a navigation').toBe(url);
	});

	test('picking one from the keyboard runs it', async ({ page }) => {
		await mockConnectingFlights(page);
		await seedHistory(page, [CURRENT_QUERY, OTHER_QUERY]);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		await page.getByRole('button', { name: 'Edit search' }).click();
		const other = page.locator('#search-editor').getByRole('link', { name: /BCN.*RIX/ });
		await other.focus();
		await page.keyboard.press('Enter');

		await page.waitForURL(/to=RIX/);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('RIX');
	});

	test('a history holding only the search on screen offers nothing', async ({ page }) => {
		// A first visit files one search and that search is this page. A heading over a row
		// nobody can follow is the control that opens nothing.
		await mockConnectingFlights(page);
		await seedHistory(page, [CURRENT_QUERY]);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		await page.getByRole('button', { name: 'Edit search' }).click();
		await expect(page.getByRole('button', { name: 'Search again' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Or pick up a recent search' })).toHaveCount(0);
		await expect(page.getByText('On screen now')).toHaveCount(0);
	});

	test('opening and closing the panel leaves focus on a control, not the document', async ({
		page
	}) => {
		// #283's defect, which #311 already had to fix once on the settings control. Driven
		// from the keyboard, which is the only way to see it.
		await mockConnectingFlights(page);
		await seedHistory(page, [CURRENT_QUERY, OTHER_QUERY]);

		await page.goto(`/results/?dep=${DEPARTURE}&arr=${ARRIVAL}&from=BCN&to=TLL`);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		await page.getByRole('button', { name: 'Edit search' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('#search-editor').getByRole('link', { name: /BCN.*RIX/ })).toBeVisible();
		expect(
			await page.evaluate(() => document.activeElement?.tagName ?? 'NONE'),
			'focus fell to the document after opening'
		).not.toBe('BODY');

		const close = page.getByRole('button', { name: 'Close' });
		await close.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('button', { name: 'Edit search' })).toBeVisible();
		expect(
			await page.evaluate(() => document.activeElement?.tagName ?? 'NONE'),
			'focus fell to the document after closing'
		).not.toBe('BODY');
	});
});
