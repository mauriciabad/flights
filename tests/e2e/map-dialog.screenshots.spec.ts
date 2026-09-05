import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { openTimeline } from './support/results-ui';

/**
 * The map dialogs, at both widths and in both schemes (issue #324).
 *
 *   pnpm exec playwright test --grep @screenshot
 *
 * Tagged out of `pnpm test:e2e` because its output is files a person looks at rather than
 * assertions, the same trade `route-previews.screenshots.spec.ts` documents.
 *
 * It exists for one reason. Issue #324 lifted the near-fullscreen shell out of
 * `RouteMapDialog` and `StaysMapDialog` into `MapDialog`, and the parts of that shell most
 * likely to be lost in a move are the parts no assertion about words can see: the margin
 * `clamp()`, the four `env(safe-area-inset-*)` calls, the `::backdrop` tint, and the 52rem
 * split whose media query lost a specificity tie once already. So the two migrated dialogs
 * are photographed beside the new one, and a reviewer comparing them against `main` is the
 * check. The stays dialog's own capture lives in `stays-map.spec.ts`, beside the fixtures it
 * needs.
 *
 * The basemap is the EMPTY style, unlike the #280 screenshots. The question these answer is
 * whether the surface around the map is right, and real vector tiles make the picture
 * nondeterministic without adding anything to that question.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

const BCN_VIE_TLL = [
	{
		dep: 'BCN',
		arr: 'VIE',
		depDate: '2027-03-08T08:00:00',
		arrDate: '2027-03-08T10:15:00',
		price: FIXTURE_PRICES.first,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[7]
	},
	{
		dep: 'VIE',
		arr: 'TLL',
		depDate: '2027-03-10T11:00:00',
		arrDate: '2027-03-10T13:20:00',
		price: FIXTURE_PRICES.third,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[8]
	},
	{
		dep: 'BCN',
		arr: 'MXP',
		depDate: '2027-03-08T09:00:00',
		arrDate: '2027-03-08T10:40:00',
		price: FIXTURE_PRICES.second,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[9]
	}
];

const VIEWPORTS = [
	{ name: '375', width: 375, height: 900 },
	{ name: '1280', width: 1280, height: 1000 }
] as const;

const SCHEMES = ['dark', 'light'] as const;

async function openResults(page: Page): Promise<void> {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), BCN_VIE_TLL);
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);

	const params = new URLSearchParams({
		dep: '2027-03-08',
		arr: '2027-03-27',
		from: 'BCN',
		to: 'TLL',
		fromLoc: 'FIXTURE start point@41.3851,2.1734',
		toLoc: 'FIXTURE end point@59.4370,24.7536'
	});
	await page.goto(`/results/?${params}`);
	await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
}

for (const viewport of VIEWPORTS) {
	for (const scheme of SCHEMES) {
		test(`@screenshot map dialogs ${viewport.name} ${scheme}`, async ({ page }) => {
			test.setTimeout(180_000);
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await page.emulateMedia({ colorScheme: scheme });
			await openResults(page);
			const suffix = `${viewport.name}-${scheme}`;

			// #324's own, list state and then a stopover read, so the panel is photographed
			// both ways round.
			await page.locator('.connections-map-link').click();
			const connections = page.locator('dialog.connections-dialog');
			await expect(connections.locator('.connection-point').first()).toBeVisible({ timeout: 30_000 });
			await page.screenshot({ path: `docs/screenshots/324-connections-list-${suffix}.png` });
			await connections.locator('.panel-row').filter({ hasText: 'VIE' }).click();
			await expect(connections.locator('.panel-price')).toBeVisible();
			await page.screenshot({ path: `docs/screenshots/324-connections-detail-${suffix}.png` });
			await page.keyboard.press('Escape');
			await expect(connections).toHaveCount(0);

			// #319's stays dialog is captured by `stays-map.spec.ts` instead, which already
			// carries the Hostelworld fixtures and the stopover-segment path it needs. A
			// second copy of that setup here would be a second thing to keep right.

			// #280's, which has no panel at all, so the map takes the whole body. That is the
			// case a shell with a panel-shaped body would break first.
			await openTimeline(page);
			await page.locator('.result-detail .ground-legs-item').nth(1).locator('.ground-leg').click();
			const route = page.locator('dialog.route-dialog');
			await expect(route.getByRole('region', { name: /Route map/ })).toBeVisible({ timeout: 30_000 });
			await page.screenshot({ path: `docs/screenshots/324-route-${suffix}.png` });
		});
	}
}
