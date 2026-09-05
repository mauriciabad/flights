import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * How much of a desktop screen the results page uses, and whether the sort control has room
 * once the list scrolls. Issue #310.
 *
 * Both halves are measured rather than looked at, and the second one is measured in the
 * scrolled state on purpose: at rest the sort control sat well clear of everything, which is
 * why nothing caught it. The owner was reading a scrolled page.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

function flights() {
	const specs = [];
	for (let index = 0; index < 6; index++) {
		const day = String(index + 8).padStart(2, '0');
		specs.push({
			dep: 'BCN',
			arr: index % 2 === 0 ? 'VIE' : 'BGY',
			depDate: `2027-03-${day}T08:00:00`,
			arrDate: `2027-03-${day}T10:15:00`,
			price: FIXTURE_PRICES.first + index * 11.11,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[index % FIXTURE_FLIGHT_NUMBERS.length]
		});
		specs.push({
			dep: index % 2 === 0 ? 'VIE' : 'BGY',
			arr: 'TLL',
			depDate: `2027-03-${String(index + 11).padStart(2, '0')}T11:00:00`,
			arrDate: `2027-03-${String(index + 11).padStart(2, '0')}T13:20:00`,
			price: FIXTURE_PRICES.second + index * 13.13,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[(index + 3) % FIXTURE_FLIGHT_NUMBERS.length]
		});
	}
	return specs;
}

async function openResults(page: Page) {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), flights());
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await waitForSearchToSettle(page, { timeout: 20_000 });
	await expect(page.locator('.result-card').first()).toBeVisible();
}

test.describe('the desktop width', () => {
	for (const width of [1280, 1440, 1920]) {
		test(`uses most of a ${width}px viewport`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await openResults(page);

			const used = (await page.locator('.results-page').boundingBox())!.width;
			// Before #310 this was capped at 72rem: 90% at 1280, 80% at 1440, 60% at 1920.
			// The floor is deliberately not the exact figure, so a later change to the shell's
			// own padding does not fail this for no reason.
			expect(used / width, `${Math.round(used)}px of ${width}px`).toBeGreaterThan(width >= 1920 ? 0.75 : 0.93);
		});
	}

	test('all three columns are still usable, not just the widest one', async ({ page }) => {
		// Stretching the list alone would leave a filter rail at its phone width beside a
		// 900px card. Three columns, in order, none of them collapsed.
		await page.setViewportSize({ width: 1920, height: 900 });
		await openResults(page);

		const filters = (await page.locator('.results-filters').boundingBox())!;
		const list = (await page.locator('.results-list-column').boundingBox())!;
		const rail = (await page.locator('.results-customise').boundingBox())!;

		expect(filters.width).toBeGreaterThan(280);
		expect(rail.width).toBeGreaterThan(340);
		expect(filters.x + filters.width).toBeLessThanOrEqual(list.x);
		expect(list.x + list.width).toBeLessThanOrEqual(rail.x);
	});
});

test.describe('the sort control once the list scrolls', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('does not meet the search summary strip pinned above it', async ({ page }) => {
		await openResults(page);
		await page.locator('.app-content').evaluate((element) => element.scrollTo(0, 600));
		await page.waitForTimeout(200);

		const gap = await page.evaluate(() => {
			const summary = document.querySelector('.summary')!.getBoundingClientRect();
			const sortLabel = document.querySelector('.filter-panel-head')!.getBoundingClientRect();
			return sortLabel.top - summary.bottom;
		});

		// It was flush at 6rem of sticky offset with no padding inside the rail. Anything
		// under a rem reads as a collision, which is what the owner saw.
		expect(gap, 'Sort by is sitting on the summary strip').toBeGreaterThan(16);
	});

	test('and the strip is still pinned, so this is the state the owner was reading', async ({
		page
	}) => {
		// Guards the test above: a gap is easy to satisfy by not scrolling at all.
		await openResults(page);
		await page.locator('.app-content').evaluate((element) => element.scrollTo(0, 600));
		await page.waitForTimeout(200);

		const scrolled = await page.locator('.app-content').evaluate((element) => element.scrollTop);
		expect(scrolled).toBeGreaterThan(300);
		const filters = (await page.locator('.results-filters').boundingBox())!;
		expect(filters.y).toBeLessThan(200);
	});
});
