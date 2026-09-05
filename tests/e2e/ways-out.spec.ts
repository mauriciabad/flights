import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Getting out of a screen you opened. Issue #311.
 *
 * Two dead ends of the same shape: flexible dates had no way back to the results it was
 * opened from, and the one control in the app chrome opened settings and could not close
 * them. The owner is explicit that the browser's back button does not count, so every
 * assertion here drives a visible control.
 *
 * Both also check the history stack did not grow, which is the difference between going
 * back and navigating forward to the same address. A forward navigation leaves the
 * traveller's own results page two back presses away, which is the state the issue is about.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });
const RESULTS_URL = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';

async function openResults(page: Page) {
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
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
	await page.goto(RESULTS_URL);
	await waitForSearchToSettle(page, { timeout: 20_000 });
	await expect(page.locator('.result-card').first()).toBeVisible();
}

const historyLength = (page: Page) => page.evaluate(() => history.length);

test.describe('flexible dates', () => {
	test('offers a way back to the results, and goes back rather than forward', async ({ page }) => {
		await openResults(page);

		await page.getByRole('link', { name: /Flexible dates/ }).click();
		await expect(page).toHaveURL(/\/results\/when\//);
		// Read here, not before the click: `history.length` counts entries and never shrinks,
		// so going back leaves it where it is and going forward adds one. The number to hold
		// still is therefore the one measured on this page, not the one before it.
		const entries = await historyLength(page);

		const back = page.getByRole('link', { name: 'Back to your results' });
		await expect(back, 'the way out is present whether or not there is a calendar to show').toBeVisible();
		await back.click();

		await expect(page).toHaveURL(/\/results\/\?/);
		await expect(page.locator('.result-card').first()).toBeVisible({ timeout: 20_000 });
		expect(
			await historyLength(page),
			'following the link forward would leave the results two back presses away'
		).toBe(entries);
	});

	test('the way back is a real link, so it can be opened in a tab', async ({ page }) => {
		// `history.back()` is the behaviour, not the markup. Somebody who arrives here from a
		// bookmark has nothing behind them, and cmd-click has to keep working either way.
		await openResults(page);
		await page.getByRole('link', { name: /Flexible dates/ }).click();

		const href = await page.getByRole('link', { name: 'Back to your results' }).getAttribute('href');
		expect(href).toContain('/results/');
		expect(href).toContain('from=BCN');
	});
});

test.describe('the settings control closes what it opened', () => {
	test('changes its name, its icon and its state when settings are open', async ({ page }) => {
		await openResults(page);
		await page.getByRole('link', { name: 'Settings' }).click();
		await expect(page).toHaveURL(/\/settings\//);

		const close = page.getByRole('link', { name: 'Close settings' });
		await expect(close).toBeVisible();
		// A control whose meaning changes has to say so to a screen reader too, or it
		// announces the wrong thing.
		await expect(close).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
	});

	test('goes back to the results the traveller was reading, not to a fresh search', async ({
		page
	}) => {
		await openResults(page);

		await page.getByRole('link', { name: 'Settings' }).click();
		await expect(page).toHaveURL(/\/settings\//);
		const entries = await historyLength(page);
		await page.getByRole('link', { name: 'Close settings' }).click();

		await expect(page).toHaveURL(/\/results\/\?/);
		await expect(page.locator('.result-card').first()).toBeVisible({ timeout: 20_000 });
		// Unchanged means it walked back. A forward navigation would add an entry here, and
		// checking settings twice would then bury the results four presses deep.
		expect(await historyLength(page)).toBe(entries);
	});

	test('leaves focus on a control, not on the document body', async ({ page }) => {
		// #283's defect: a browser blurred a button the moment it changed and a keyboard
		// reader lost the control entirely. Driven from the keyboard, which is the only way
		// to see it.
		await openResults(page);
		await page.getByRole('link', { name: 'Settings' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/settings\//);

		await page.getByRole('link', { name: 'Close settings' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/results\/\?/);

		const focused = await page.evaluate(() => document.activeElement?.tagName ?? 'NONE');
		expect(focused, 'focus fell to the document after closing').not.toBe('BODY');
	});

	test('opens settings again from the same control, which is what makes it a toggle', async ({
		page
	}) => {
		await openResults(page);
		await page.getByRole('link', { name: 'Settings' }).click();
		await page.getByRole('link', { name: 'Close settings' }).click();
		await expect(page).toHaveURL(/\/results\/\?/);
		await page.getByRole('link', { name: 'Settings' }).click();
		await expect(page).toHaveURL(/\/settings\//);
	});
});

test.describe('the search editor', () => {
	test('says and shows the same thing when it is open', async ({ page }) => {
		await openResults(page);
		await page.getByRole('button', { name: 'Edit search' }).click();

		const close = page.getByRole('button', { name: 'Close' });
		await expect(close).toBeVisible();
		await expect(close).toHaveAttribute('aria-expanded', 'true');
		await close.click();
		await expect(page.getByRole('button', { name: 'Edit search' })).toBeVisible();
	});
});
