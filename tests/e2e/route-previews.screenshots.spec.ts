import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { openTimeline } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * The pictures in `docs/screenshots/`, captured rather than described (issue #280).
 *
 *   pnpm exec playwright test --grep @screenshot
 *
 * Tagged out of `pnpm test:e2e` because it asserts almost nothing: its output is files a
 * person looks at, and paying for four viewport-and-scheme combinations on every CI run to
 * regenerate images nobody reads is not a trade worth making. It stays in the suite so the
 * pictures in a PR can be reproduced by whoever doubts them, which is the only thing that
 * makes a screenshot evidence rather than decoration.
 *
 * The basemap is the real CARTO style here, not the empty one the behavioural specs use:
 * the whole question a person is looking at these to answer is whether the map inside the
 * dialog reads properly in both colour schemes, and an empty style would answer it with a
 * blank rectangle. Nothing on the list costs money (AGENTS.md: CARTO, Ryanair, OSRM and
 * Transitous are all keyless), and every fare on screen is a fixture marker.
 */

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
	}
];

const VIEWPORTS = [
	{ name: '375', width: 375, height: 900 },
	{ name: '1280', width: 1280, height: 1000 }
] as const;

const SCHEMES = ['dark', 'light'] as const;

async function openResults(page: Page, toLoc = 'FIXTURE end point@59.4370,24.7536'): Promise<void> {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), BCN_VIE_TLL);
	// The network guard blocks everything no mock answered, so real tiles need letting
	// through by name. Registered after the guard, which is what makes it win: Playwright
	// asks the newest matching route first.
	// Every host the style reaches for, not just the one in `style.ts`: the document lives
	// on `basemaps.`, sprites on `tiles.basemaps.`, and the vector tiles are sharded across
	// `tiles-a.` to `tiles-d.`. A pattern that misses one of those fails at teardown with
	// six blocked tiles rather than at the assertion, which is a slow way to learn it.
	await page.context().route(/https:\/\/[a-z-]*\.?basemaps\.cartocdn\.com\//, (route) => route.continue());

	const params = new URLSearchParams({
		dep: '2027-03-08',
		arr: '2027-03-27',
		from: 'BCN',
		to: 'TLL',
		fromLoc: 'FIXTURE start point@41.3851,2.1734',
		toLoc
	});
	await page.goto(`/results/?${params}`);
	await waitForSearchToSettle(page, { timeout: 20_000 });
}

for (const viewport of VIEWPORTS) {
	for (const scheme of SCHEMES) {
		test(`@screenshot ${viewport.name} ${scheme}`, async ({ page }) => {
			test.setTimeout(120_000);
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await page.emulateMedia({ colorScheme: scheme });
			await openResults(page);

			const card = page.locator('.result-card').first();
			await expect(card.locator('.flight-shape .route-preview')).toBeVisible();
			await card.screenshot({ path: `docs/screenshots/280-card-${viewport.name}-${scheme}.png` });

			await openTimeline(page);
			const previews = page.locator('.result-detail .ground-legs-row');
			await expect(previews.locator('.ground-leg')).toHaveCount(3);
			await previews.screenshot({
				path: `docs/screenshots/280-ground-previews-${viewport.name}-${scheme}.png`
			});

			await previews.locator('.ground-leg').nth(1).click();
			const dialog = page.locator('dialog.route-dialog');
			await expect(dialog.getByRole('region', { name: /Route map/ })).toBeVisible();
			// A marker only exists once MapLibre has fired `load` and the model has been
			// drawn, so this waits for the map rather than for a number of seconds. The first
			// capture used a flat 4s and photographed a loading skeleton with the zoom
			// controls painted over it, which is a convincing picture of a broken map.
			await expect(dialog.locator('.itinerary-marker').first()).toBeVisible({ timeout: 30_000 });
			// And then a beat for the vector tiles themselves.
			await page.waitForTimeout(3_000);
			await page.screenshot({
				path: `docs/screenshots/280-dialog-${viewport.name}-${scheme}.png`
			});
		});
	}
}

/**
 * The one ground preview that has water in it, which is what proves the backdrop is
 * deciding rather than always filling (issue #346).
 *
 * Every other picture in this file is a fill: `land.ts` will not draw a coast into a
 * window narrower than twelve times the outline's own measured placement error, and an
 * airport-to-hotel hop is a 20 km window against 6.8 km of slack. Kuressaare is on
 * Saaremaa, 180 km across the Baltic from Tallinn's airport, which is wide enough for the
 * outline to be worth believing, so this one draws the sea between the two.
 *
 * It is here because a reviewer looking at a flat grey thumbnail cannot tell "the rule
 * fired" from "the feature is broken", and one picture settles it.
 */
test('@screenshot ground preview across water', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 1000 });
	await openResults(page, 'FIXTURE island point@58.2528,22.4894');
	await openTimeline(page);

	const previews = page.locator('.result-detail .ground-legs-row');
	await expect(previews.locator('.ground-leg')).toHaveCount(3);
	await previews.screenshot({ path: 'docs/screenshots/346-ground-preview-across-water.png' });
});
