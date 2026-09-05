import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { openTimeline } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #286: the way to the map's "nothing to draw, and here is why" sentence.
 *
 * Issue #141 gave the map a sentence for every step it cannot draw, and #280 closed the
 * only door to it: the map moved into a dialog reached by tapping a frozen preview, a leg
 * with no geometry gets no preview (the owner's rule, and the right one), and the timeline
 * row that used to move the map is inert behind a modal. The sentence went on passing its
 * unit tests with no traveller able to reach it.
 *
 * So this file is about reachability, and it takes the traveller's own path: search, open
 * a card, tap a preview, press the leg nobody routed, read the answer. The assertions are
 * geometry as much as wording. `45151ce` shipped a component whose segments rendered zero
 * pixels wide while five e2e tests passed on the strength of the right words being in the
 * DOM, so "the sentence is in the document" is not what is checked below: it has a box, it
 * sits inside the dialog, and the point at its centre hits the sentence itself and not
 * something painted over it.
 *
 * The scenario is a stopover nobody could route into. OSRM and Transitous answer normally
 * for the two outer legs and come back empty for the Vienna-area pairs, which is issue
 * #211's real state: flights priced, free time real, and no way into the city that any
 * provider would name.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

const ABSENT_LEG_SENTENCE = 'Nothing to draw. Nothing routed into the city for this stopover.';

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

async function searchWithAnUnroutableStopover(page: Page): Promise<void> {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), BCN_VIE_TLL);
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);

	// Registered after the keyless mocks, so these match first and `route.fallback()` hands
	// everything else back to the fixtures. Split by coordinate rather than by turning the
	// provider off: a search with no routing at all has no ground legs to draw and falls
	// through to `GroundLegPreviews`' one-button fallback, which is a different screen from
	// the one this file is about. Vienna is the only leg in this trip near 16°E / 48°N.
	await page.context().route('https://routing.openstreetmap.de/**', async (route) => {
		if (/[/;]16\.\d/.test(route.request().url())) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ code: 'NoRoute', message: 'no route found between points' })
			});
			return;
		}
		await route.fallback();
	});
	await page.context().route('https://api.transitous.org/**', async (route) => {
		if (/48\.\d/.test(route.request().url())) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ itineraries: [] })
			});
			return;
		}
		await route.fallback();
	});

	const params = new URLSearchParams({
		dep: '2027-03-08',
		arr: '2027-03-27',
		from: 'BCN',
		to: 'TLL',
		fromLoc: 'FIXTURE start point@41.3851,2.1734',
		toLoc: 'FIXTURE end point@59.4370,24.7536'
	});
	await page.goto(`/results/?${params}`);
	await waitForSearchToSettle(page, { timeout: 30_000 });
	// #278 took the card-level expand away: the trip strip's own stopover caption unfolds
	// the timeline now, and `openTimeline` is where that gesture lives for every spec.
	await openTimeline(page);
	await expect(page.locator('.result-detail')).toBeVisible();
}

test.describe('a leg the map cannot draw (issue #286)', () => {
	test('has no preview to tap, which is what closed the old way in', async ({ page }) => {
		await searchWithAnUnroutableStopover(page);

		const detail = page.locator('.result-detail');
		// Two, not three: the stopover leg has no geometry, so it gets no thumbnail. This is
		// the premise of the whole issue rather than a thing under test, and it is asserted
		// so that a change making the stopover routable again turns this file red instead of
		// leaving it passing against a scenario that no longer exists.
		await expect(detail.locator('.ground-legs-item')).toHaveCount(2);
		await expect(detail.getByText('The stopover', { exact: true })).toHaveCount(0);
		// The row a traveller would have clicked before #280 still carries the reason, and
		// clicking it cannot reach the map any more: the map is behind a modal it opens.
		await expect(detail.locator('.tl-row[data-segment="transfer-to-hotel"]')).toContainText(
			'Nothing routed into the city for this stopover.'
		);
	});

	test('is reachable inside the dialog, and answers with a sentence that has a box', async ({
		page
	}) => {
		await searchWithAnUnroutableStopover(page);

		await page.locator('.result-detail .ground-leg').first().click();
		const dialog = page.locator('dialog.route-dialog');
		await expect(dialog).toBeVisible();

		// Every ground leg of the trip, including the one with nothing behind it.
		const steps = dialog.locator('.map-step');
		await expect(steps).toHaveText([
			'To the airport',
			'To the stopover',
			'To the connection airport',
			'To the destination'
		]);

		const stopover = dialog.locator('.map-step', { hasText: 'To the stopover' });
		const stepBox = await stopover.boundingBox();
		expect(stepBox, 'the leg button must have a bounding box').not.toBeNull();
		expect(stepBox!.width, 'leg button width').toBeGreaterThan(60);
		expect(stepBox!.height, 'leg button height').toBeGreaterThan(20);

		// WCAG 2.5.5: the pill is 28px so a row of four does not tower over the map, and an
		// invisible pseudo-element carries the hit target to 44px. A box measurement cannot
		// see that, so this asks the browser what is actually under the finger 20px above
		// the pill's middle.
		const hitTarget = await page.evaluate(({ x, y }) => {
			const element = document.elementFromPoint(x, y);
			return element instanceof HTMLElement ? element.className : null;
		}, { x: stepBox!.x + stepBox!.width / 2, y: stepBox!.y + stepBox!.height / 2 - 20 });
		expect(hitTarget, 'the 44px hit target above the pill').toContain('map-step');

		await stopover.click();

		const status = dialog.locator('.map-status');
		await expect(status.locator('.map-status-text')).toHaveText(ABSENT_LEG_SENTENCE);
		// Never colour alone and never wording alone: the absence gets the hollow swatch and
		// the muted treatment as well as the sentence.
		await expect(status).toHaveClass(/is-absent/);
		await expect(status.locator('.map-status-swatch-none')).toHaveCount(1);
		await expect(stopover).toHaveAttribute('aria-current', 'true');

		// The sentence is on screen, not merely in the document. Width, and inside the
		// dialog's own rectangle rather than clipped past its edge.
		const statusBox = await status.boundingBox();
		const dialogBox = await dialog.boundingBox();
		expect(statusBox, 'the status line must have a bounding box').not.toBeNull();
		expect(statusBox!.width, 'status line width').toBeGreaterThan(200);
		expect(statusBox!.height, 'status line height').toBeGreaterThan(10);
		expect(statusBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
		expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);

		// And nothing is painted over it: the point where the sentence starts hits the
		// sentence. A scrim or an absolutely-positioned map control covering the caption
		// would pass every assertion above.
		const onTop = await page.evaluate(({ x, y }) => {
			const element = document.elementFromPoint(x, y);
			return element?.textContent?.trim() ?? null;
		}, { x: statusBox!.x + 40, y: statusBox!.y + statusBox!.height / 2 });
		expect(onTop, 'what is painted where the sentence is').toContain('Nothing to draw.');

		// One map, still. Pressing a leg with nothing to draw must not tear the map down or
		// build a second one.
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(1);
	});

	test('is reachable by keyboard, and the whole route is still one press away', async ({
		page
	}) => {
		await searchWithAnUnroutableStopover(page);

		await page.locator('.result-detail .ground-leg').first().click();
		const dialog = page.locator('dialog.route-dialog');
		await expect(dialog).toBeVisible();

		const stopover = dialog.locator('.map-step', { hasText: 'To the stopover' });
		await stopover.focus();
		await expect(stopover).toBeFocused();
		await page.keyboard.press('Enter');

		await expect(dialog.locator('.map-status-text')).toHaveText(ABSENT_LEG_SENTENCE);

		// Out again, without closing the dialog: a leg with nothing to draw is not a dead
		// end a traveller has to Escape from.
		await dialog.getByRole('button', { name: 'Show whole route' }).click();
		await expect(dialog.locator('.map-status-text')).toHaveText('Showing the whole route.');
		await expect(dialog.locator('.map-step[aria-current="true"]')).toHaveCount(0);
	});
});
