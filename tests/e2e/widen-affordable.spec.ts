import { expect, test } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES, FIXTURE_TEXT_TOKEN } from './support/fixture-markers';
import { mockAllKeylessProviders, mockSkyscanner, routeRyanairFlights } from './support/providers';

/**
 * Issue #244: "Confirm an exact price" quoted ~55 requests across 5 stopovers against Sky
 * Scrapper's 15-request cap, so the row rendered permanently disabled and no reachable
 * action in this app ever spent a Skyscanner request. The key the owner called
 * non-negotiable was dead in practice, and nothing in either suite looked at this panel.
 *
 * This is the check that would have caught it: with a Skyscanner key configured and a
 * search that ranks real stopovers, the confirm row has to be something a person can press.
 *
 * Nothing here presses it. The row's quoted cost is the whole defect, and reading a label
 * spends nothing — see AGENTS.md on the owner's quota. Skyscanner is mocked anyway so the
 * network guard would block a real call, but the point stands for whoever extends this.
 */

const KEY_STORAGE = 'flights.byokKeys.v1';
const QUOTA_STORAGE = 'flights.providerBudget.v1';
/** Marked, so a key that somehow escaped this test is recognisable as fake at a glance and
 * could never be mistaken for the owner's own (tests/e2e/fixtures/markers.json). */
const FAKE_KEY = `${FIXTURE_TEXT_TOKEN}-not-a-real-rapidapi-key`;

/** BCN -> VIE -> TLL, the chain the other results specs use, so the search really produces
 * cards and a ranked candidate list rather than an empty board. */
async function mockConnectingFlights(page: import('@playwright/test').Page) {
	await mockAllKeylessProviders(page.context());
	await mockSkyscanner(page.context());
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

const RESULTS_URL = '/results/?dep=2027-03-08&depLatest=2027-03-11&arr=2027-03-27&from=BCN&to=TLL';

/** Same shape `budget/month-key.ts` writes, so a seeded record counts as this month's. */
function currentMonthKey(): string {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function skyscannerConfirmRow(page: import('@playwright/test').Page) {
	const panel = page.getByRole('group', { name: 'Widen this search' });
	await expect(panel).toBeVisible();
	const row = panel
		.locator('.widen-group')
		.filter({ hasText: 'Confirm an exact price' })
		.locator('.widen-row')
		.filter({ hasText: 'Skyscanner (RapidAPI)' });
	await expect(row).toHaveCount(1);
	return row;
}

async function quotedRequests(row: import('@playwright/test').Locator): Promise<number> {
	const cost = await row.locator('.widen-row-cost').innerText();
	const quoted = Number(/~(\d+) request/.exec(cost)?.[1]);
	expect(Number.isFinite(quoted)).toBe(true);
	return quoted;
}

test.describe('the confirm-price widen is an action a person can take', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(
			([storageKey, apiKey]) => {
				localStorage.setItem(storageKey, JSON.stringify({ skyscanner: { apiKey } }));
			},
			[KEY_STORAGE, FAKE_KEY]
		);
		await mockConnectingFlights(page);
	});

	test('leaves the button pressable, at a cost inside the Sky Scrapper cap', async ({ page }) => {
		await page.goto(RESULTS_URL);

		const row = await skyscannerConfirmRow(page);
		// The claim the issue is about: this is an action, not a notice.
		await expect(row.getByRole('button', { name: 'Confirm price' })).toBeEnabled();
		await expect(row).not.toContainText('left this month');

		// And the quoted number, read off the screen the way the issue read 55 off it. Sky
		// Scrapper's default cap is 15 (providers/budget/caps.ts, from a measured 20-a-month
		// free tier); anything above it is a row nobody can ever press.
		expect(await quotedRequests(row)).toBeLessThanOrEqual(15);
	});

	test('offers the stopovers a nearly-spent month can still pay for', async ({ page }) => {
		// Nine of Sky Scrapper's fifteen already gone, so six are left and a confirm at two
		// a stopover buys three of them. Before issue #244 a row that could not cover every
		// stopover covered none.
		await page.addInitScript(
			([storageKey, monthKey]) => {
				localStorage.setItem(storageKey, JSON.stringify({ skyscanner: { monthKey, used: 9 } }));
			},
			[QUOTA_STORAGE, currentMonthKey()]
		);
		await page.goto(RESULTS_URL);

		const row = await skyscannerConfirmRow(page);
		await expect(row.getByRole('button', { name: 'Confirm price' })).toBeEnabled();
		expect(await quotedRequests(row)).toBeLessThanOrEqual(6);
		await expect(row.locator('.widen-row-cost')).toContainText(/across \d+ of \d+ stopovers/);
		await expect(row).toContainText('this month has not got');
	});
});
