import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';

/**
 * Issue #280: the frozen previews, and the one map that is still a map.
 *
 * Every assertion here is about geometry, not only about semantics. `45151ce` fixed the
 * trip strip rendering between zero and two pixels wide on production while five e2e tests
 * passed, because all five asked whether a panel opened and whether the words were right.
 * A frozen preview that renders as a 0x0 `<svg>` would sail through the same kind of test,
 * so every check below reads a bounding box.
 *
 * The other property under test is the one the measurement in `tools/probe-map-cost.mjs`
 * bought: the previews create no WebGL context at all, the dialog creates exactly one, and
 * closing it takes that one away. A leak there does not break anything visible until a
 * traveller's ninth dialog, which is exactly the kind of defect no one traces back.
 *
 * Fare values come from `support/fixture-markers.ts` for the reason that file explains.
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
	}
];

/** The two ends are opt-in: `search/pipeline.ts` only asks a transfer provider about them
 *  when the query names a location, and an itinerary with no origin location is exactly
 *  the "then show two, slightly wider" case the owner asked for. */
async function search(page: Page, ends: { fromLoc?: string; toLoc?: string }): Promise<void> {
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
		...ends
	});
	await page.goto(`/results/?${params}`);
	await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
}

const BOTH_ENDS = {
	fromLoc: 'FIXTURE start point@41.3851,2.1734',
	toLoc: 'FIXTURE end point@59.4370,24.7536'
};

test.describe('frozen route previews (issue #280)', () => {
	test('the card carries a flight picture with real size, captioned against a direct flight', async ({
		page
	}) => {
		await search(page, BOTH_ENDS);

		const card = page.locator('.result-card').first();
		const picture = card.locator('.flight-shape-picture .route-preview');
		await expect(picture).toBeVisible();

		// Not "an svg exists". A drawing nobody can see is the defect this asserts against.
		const box = await picture.boundingBox();
		expect(box, 'the flight picture must have a bounding box').not.toBeNull();
		expect(box!.width).toBeGreaterThan(60);
		expect(box!.height).toBeGreaterThan(40);

		// Three strokes drawn: the two flown legs, and the direct line that is not one.
		await expect(card.locator('.flight-shape-picture path.rp-leg')).toHaveCount(2);
		await expect(card.locator('.flight-shape-picture path.rp-baseline')).toHaveCount(1);

		// The caption is what stops the dashed line reading as a route, so it is the thing
		// worth pinning in words.
		await expect(card.locator('.flight-shape-caption')).toContainText('direct flight');
	});

	test('the previews make no WebGL context, however many cards are on screen', async ({ page }) => {
		await search(page, BOTH_ENDS);

		await expect(page.locator('.result-card').first()).toBeVisible();
		for (const toggle of await page.getByRole('button', { name: 'Show details' }).all()) {
			await toggle.click();
		}
		await expect(page.locator('.ground-legs-item').first()).toBeVisible();

		// Counted, not assumed: a zero-context assertion passes for the wrong reason if the
		// page happens to be holding no previews. This fixture yields one card, so four is
		// what one card asks for, and four live contexts per card is the arithmetic that
		// puts a results page over Chromium's sixteen at the fifth card.
		// `tools/probe-map-cost.mjs` is where that ceiling is measured across card counts;
		// a browser test cannot conjure five itineraries out of two mocked flights.
		expect(await page.locator('.route-preview').count()).toBeGreaterThanOrEqual(4);

		// The whole reason these are SVG. Chromium evicts the oldest of more than sixteen
		// live contexts, and four per card would put the ceiling at four cards.
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);
	});

	test('asking about public transport neither strips nor duplicates a preview', async ({ page }) => {
		// #282 added an on-demand timetable lookup that can change a transfer row's shape
		// after a press. These previews derive from the same `Itinerary`, so they follow it,
		// and the concern is whether following it can leave the row wrong: a leg vanishing,
		// or a second copy of one appearing.
		await search(page, BOTH_ENDS);
		await page.getByRole('button', { name: 'Show details' }).first().click();

		const detail = page.locator('.result-detail');
		const items = detail.locator('.ground-legs-item');
		await expect(items).toHaveCount(3);

		const check = detail.getByRole('button', { name: 'Check public transport' }).first();
		// The control is conditional on the itinerary having something to ask about, so this
		// test asserts the invariant only when the press is actually available.
		if ((await check.count()) > 0) {
			await check.click();
			await expect(check).toBeEnabled({ timeout: 20_000 });
		}

		await expect(items).toHaveCount(3);
		// Keyed on a fixed set of three preview ids, so a duplicate is not representable;
		// this checks the row is still one preview per leg and not one per timeline row.
		await expect(detail.locator('.ground-leg')).toHaveCount(3);
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);
	});

	test('three ground legs render three previews, each with real size', async ({ page }) => {
		await search(page, BOTH_ENDS);
		await page.getByRole('button', { name: 'Show details' }).first().click();

		const detail = page.locator('.result-detail');
		const items = detail.locator('.ground-legs-item');
		await expect(items).toHaveCount(3);

		for (const label of ['To the airport', 'The stopover', 'To the destination']) {
			await expect(detail.getByText(label, { exact: true })).toBeVisible();
		}

		for (let index = 0; index < 3; index++) {
			const box = await items.nth(index).locator('.route-preview').boundingBox();
			expect(box, `preview ${index} must have a bounding box`).not.toBeNull();
			expect(box!.width, `preview ${index} width`).toBeGreaterThan(40);
			expect(box!.height, `preview ${index} height`).toBeGreaterThan(30);
		}
	});

	test('a missing origin location leaves two previews, each wider than three would be', async ({ page }) => {
		await search(page, { toLoc: BOTH_ENDS.toLoc });
		await page.getByRole('button', { name: 'Show details' }).first().click();

		const detail = page.locator('.result-detail');
		const items = detail.locator('.ground-legs-item');
		await expect(items).toHaveCount(2);
		await expect(detail.getByText('To the airport', { exact: true })).toHaveCount(0);

		// The owner asked for "only 2 maps in this case sigtly wider", so width is the
		// assertion. Two previews sharing a row are each near half of it; three would be
		// near a third, and the gap between those two figures is what this pins.
		const rowBox = (await detail.locator('.ground-legs-row').boundingBox())!;
		const firstBox = (await items.first().locator('.route-preview').boundingBox())!;
		expect(firstBox.width).toBeGreaterThan(rowBox.width / 3);
	});

	test('tapping a preview opens one map, and closing it takes the map away and gives focus back', async ({
		page
	}) => {
		await search(page, BOTH_ENDS);
		await page.getByRole('button', { name: 'Show details' }).first().click();

		const detail = page.locator('.result-detail');
		const trigger = detail.locator('.ground-leg').first();
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);

		await trigger.click();

		const dialog = page.locator('dialog.route-dialog');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('region', { name: /Route map/ })).toBeVisible();
		// Exactly one, never one per preview.
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(1);

		// Near-fullscreen: a fixed margin and nothing more.
		const dialogBox = (await dialog.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(dialogBox.width).toBeGreaterThan(viewport.width * 0.8);
		expect(dialogBox.width).toBeLessThan(viewport.width);

		await page.keyboard.press('Escape');

		await expect(dialog).toHaveCount(0);
		// The instance is gone, not merely hidden. A dialog that leaked one per open would
		// walk a session into the same sixteen-context ceiling, one dialog at a time.
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});

	test('the close button returns to the results the same way Escape does', async ({ page }) => {
		await search(page, BOTH_ENDS);
		await page.getByRole('button', { name: 'Show details' }).first().click();

		const trigger = page.locator('.result-detail .ground-leg').first();
		await trigger.click();

		const dialog = page.locator('dialog.route-dialog');
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: 'Close' }).click();

		await expect(dialog).toHaveCount(0);
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});

	test('ten opens and closes leave no map behind', async ({ page }) => {
		await search(page, BOTH_ENDS);
		await page.getByRole('button', { name: 'Show details' }).first().click();

		const previews = page.locator('.result-detail .ground-leg');
		const dialog = page.locator('dialog.route-dialog');
		const canvases = page.locator('canvas.maplibregl-canvas');

		// One open and close proves teardown runs. Ten prove it runs every time, which is
		// the shape this defect would have: nothing visibly wrong until Chromium evicts the
		// oldest of sixteen live contexts, long after the change that caused it.
		for (let round = 0; round < 10; round++) {
			await previews.nth(round % 3).click();
			await expect(dialog).toBeVisible();
			await expect(canvases).toHaveCount(1);
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect(canvases).toHaveCount(0);
		}
	});

	test('the dialog opens framed on the leg that was tapped', async ({ page }) => {
		await search(page, BOTH_ENDS);
		await page.getByRole('button', { name: 'Show details' }).first().click();

		// The stopover leg, second of the three, so a wrong pick reads as the wrong sentence
		// rather than coincidentally matching the first.
		await page.locator('.result-detail .ground-legs-item').nth(1).locator('.ground-leg').click();

		const dialog = page.locator('dialog.route-dialog');
		// The map's own status line names what it is showing, and it is the leg the button
		// carried rather than the whole route.
		await expect(dialog.locator('.map-status')).not.toContainText('Showing the whole route');
		// The heading names the journey, not the leg (issue #286: the map inside can be moved
		// between legs, and a heading fixed at the thumbnail that opened it would then be
		// describing something else). Which leg is on screen is the status line above and the
		// pressed leg button below it.
		await expect(dialog.getByRole('heading')).toHaveText('Route map: Barcelona to Tallinn');
		await expect(dialog.locator('.map-step[aria-current="true"]')).toHaveText('To the stopover');
	});
});
