import { expect, test, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline, pickStripSegment } from './support/results-ui';

/**
 * Issues #319 and #307: the stay list, the map it opens, and the photographs.
 *
 * Every assertion here reads a box, a count or a decoded pixel. That is not belt and
 * braces. `45151ce` shipped the trip strip rendering between zero and two pixels wide while
 * five e2e tests passed, because all five asked whether a panel opened and whether the
 * words were right, and both are true of an element that has collapsed to nothing. The
 * defect this file exists to prevent is exactly that shape: a name truncated to 50px inside
 * a 312px row, which is what the alternatives list was doing before this branch.
 *
 * The other property under test is the one issue #280 bought and this map must not spend: a
 * results page holds no live WebGL context, the dialog holds exactly one, and closing it
 * takes that one away. `tools/probe-map-cost.mjs` measured Chromium evicting the oldest past
 * sixteen, so a leak here goes unnoticed until a traveller's ninth dialog.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** A real image with real intrinsic dimensions and no binary fixture to check in. An `<img>`
 * decodes an SVG like any other format and `naturalWidth` reports what the file says, so
 * "did a picture actually decode" is answerable - which a `fetch` cannot answer, since an
 * image tag is a no-cors request that ignores the headers a fetch reads. */
function photo(label: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect width="100%" height="100%" fill="#264653"/><text x="24" y="120" font-size="72" fill="#e9c46a">${label}</text></svg>`;
}

/** Every photograph the page actually asked the network for, in order. The count is the
 * point: Hostelworld serves 2.8 MB originals and honours no resize (issue #284), so how many
 * of these a screen pulls at once is a number this branch has to keep small. */
async function openStays(page: Page): Promise<string[]> {
	const requested: string[] = [];
	await mockAllKeylessProviders(page.context());
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna-many.json'
	);
	await page.context().route('https://photos.fixture.invalid/**', async (route) => {
		requested.push(route.request().url());
		await route.fulfill({
			status: 200,
			contentType: 'image/svg+xml',
			body: photo(route.request().url().split('/').pop() ?? '')
		});
	});
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

	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	// The reading this file takes is worthless while a provider is still answering: a card
	// measured mid-search is a card whose stay list has not arrived.
	await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 30_000 });
	await expect(page.locator('.result-card').first()).toBeVisible();
	await openTimeline(page);
	await pickStripSegment(page, 'stopover');
	await expect(customiser(page).locator('.stay-alternatives')).toBeVisible({ timeout: 20_000 });

	// And then wait for the photographs it asked for, which is a separate event (issue
	// #331). Every one of these is `loading="lazy"` and every one of them is below the
	// fold, so Chromium starts them after layout: instrumented on a quiet machine, the
	// list became visible at 2264ms and its six requests landed between 2163 and 2235.
	// A count taken on the line above is a number still moving, and one test here
	// compares such a count against itself 200ms later while another reads a thumbnail's
	// `naturalWidth`. Both are asking the same thing, so it is asked once, here: after
	// this line the page has fetched what it wants, and a request recorded later came
	// from something the test did.
	const settled = page.locator('img[src*="photos.fixture.invalid"]');
	await expect
		.poll(
			() =>
				settled.evaluateAll(
					(images) => images.length > 0 && images.every((image) => (image as HTMLImageElement).complete)
				),
			{ timeout: 20_000 }
		)
		.toBe(true);

	return requested;
}

/**
 * Issue #324 moved this dialog's near-fullscreen shell into `MapDialog`, and the parts of
 * that shell no assertion about words can see are the margin `clamp()`, the safe-area
 * insets, the `::backdrop` tint and the 52rem split. So the surface is photographed at both
 * widths in both schemes, and a reviewer comparing against `main` is the check. Tagged
 * `@screenshot`, out of `pnpm test:e2e`, for the reason `route-previews.screenshots.spec.ts`
 * gives: its output is files a person looks at.
 */
for (const width of [375, 1280] as const) {
	for (const scheme of ['dark', 'light'] as const) {
		test(`@screenshot stays dialog ${width} ${scheme}`, async ({ page }) => {
			test.setTimeout(180_000);
			await page.setViewportSize({ width, height: width === 375 ? 900 : 1000 });
			await page.emulateMedia({ colorScheme: scheme });
			await openStays(page);
			await page.locator('.stay-map-open').click();
			const dialog = page.locator('dialog.stays-dialog');
			await expect(dialog.getByTestId('stays-sidebar')).toBeVisible({ timeout: 30_000 });
			// A point only exists once MapLibre has fired `load` and the markers are drawn.
			// Shooting on the sidebar alone photographed an empty rectangle, which is a
			// convincing picture of a broken map.
			await expect(page.locator('.stay-point').first()).toBeVisible({ timeout: 30_000 });
			await page.screenshot({ path: `docs/screenshots/324-stays-${width}-${scheme}.png` });
		});
	}
}

test.describe('the alternatives list (issue #319)', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('gives the property name most of the row instead of 50px of it', async ({ page }) => {
		await openStays(page);

		const card = page.locator('.alt-card').first();
		const name = card.locator('.alt-card-name');
		const cardBox = (await card.boundingBox())!;
		const nameBox = (await name.boundingBox())!;

		// Before this branch the price column's intrinsic width starved the body: a 312px
		// row gave the name 50px and truncated a 144px string into it. Half the row is the
		// floor, and it is a wide margin over what was there.
		expect(nameBox.width).toBeGreaterThan(cardBox.width * 0.5);

		// And it is not truncated: the text fits the box it was given rather than being
		// clipped inside it. `scrollWidth` is what catches an ellipsis a screenshot hides.
		const overflow = await name.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(overflow, 'the name is being clipped rather than wrapped').toBeLessThanOrEqual(1);

		// The row got shorter as well as more readable: 254px of mostly-empty height was
		// three short phrases wrapping down a 50px column.
		expect(cardBox.height).toBeLessThan(200);
	});

	test('shows what swapping costs, not only what each bed costs', async ({ page }) => {
		await openStays(page);

		const deltas = page.locator('.alt-card-delta-value');
		await expect(deltas.first()).toBeVisible();
		expect(await deltas.count()).toBeGreaterThan(0);

		// Per night is the headline figure, for the reason `choice.ts` argues: a stopover can
		// book zero nights, and every whole-stay delta is then zero.
		for (const text of await deltas.allInnerTexts()) {
			expect(text).toMatch(/^([+-]\S+\/night|Same nightly rate|Priced in [A-Z]{3})$/);
		}
		// Signed, so colour is never the only channel carrying the direction (WCAG 1.4.1).
		expect(await deltas.first().innerText()).toMatch(/^[+-]/);
	});

	test('loads one photograph per row and no more, all of them lazily', async ({ page }) => {
		await openStays(page);

		const thumbs = page.locator('.alt-card-thumb img');
		expect(await thumbs.count()).toBeGreaterThan(0);
		for (const loading of await thumbs.evaluateAll((els) =>
			els.map((el) => (el as HTMLImageElement).loading)
		)) {
			expect(loading, 'a stay thumbnail is eager').toBe('lazy');
		}

		// Decoded pixels from a real `<img>` on an http origin, never a `fetch`: an image tag
		// is a no-cors request that ignores the header a fetch reads.
		const natural = await thumbs.first().evaluate((el: HTMLImageElement) => el.naturalWidth);
		expect(natural).toBeGreaterThan(0);
	});
});

test.describe('the stay map (issues #319 and #280)', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('the list carries a drawing and no WebGL, however many stays it holds', async ({ page }) => {
		await openStays(page);

		const preview = page.locator('.stay-map-open .route-preview');
		await expect(preview).toBeVisible();

		// Not "an svg exists": a drawing nobody can see is the defect this asserts against.
		const box = (await preview.boundingBox())!;
		expect(box.width).toBeGreaterThan(60);
		expect(box.height).toBeGreaterThan(30);

		// One dot per property plus the airport, so the picture is of this list rather than
		// of a fixed shape.
		const rows = await page.locator('.alt-card').count();
		expect(await preview.locator('circle.rp-dot').count()).toBe(rows + 2);

		// The whole reason it is an SVG. Four live contexts per card would put a results page
		// over Chromium's sixteen at the fifth card.
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);
	});

	test('opening the map makes exactly one, and closing it takes that one away', async ({ page }) => {
		await openStays(page);
		const trigger = page.locator('.stay-map-open');
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);

		await trigger.click();
		const dialog = page.locator('dialog.stays-dialog');
		await expect(dialog).toBeVisible();
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(1);

		// Near-fullscreen: a fixed margin and nothing more.
		const dialogBox = (await dialog.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(dialogBox.width).toBeGreaterThan(viewport.width * 0.8);
		expect(dialogBox.width).toBeLessThan(viewport.width);

		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});

	test('ten opens and closes leave no map behind', async ({ page }) => {
		await openStays(page);
		const trigger = page.locator('.stay-map-open');
		const dialog = page.locator('dialog.stays-dialog');
		const canvases = page.locator('canvas.maplibregl-canvas');

		// One round proves teardown runs. Ten prove it runs every time, which is the shape
		// this defect would have: nothing visibly wrong until the seventeenth context.
		for (let round = 0; round < 10; round++) {
			await trigger.click();
			await expect(dialog).toBeVisible();
			await expect(canvases).toHaveCount(1);
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect(canvases).toHaveCount(0);
		}
	});

	test('a point opens that property in the sidebar, and Back returns to the list', async ({ page }) => {
		const requested = await openStays(page);
		// Emptied rather than measured. `openStays` has waited for every photograph the
		// results page wanted, so the log is finished, and starting from nothing makes the
		// assertion below say "the dialog fetched none" instead of "a count did not move"
		// against a page it is not asking about (issue #331).
		requested.length = 0;

		await page.locator('.stay-map-open').click();
		const dialog = page.locator('dialog.stays-dialog');
		await expect(dialog).toBeVisible();

		// A map with every property on it, each one a real button rather than a canvas hit
		// test, which is what makes this reachable without a pointer.
		const points = dialog.locator('button.stay-point');
		const rows = await page.locator('.alt-card').count();
		await expect(points).toHaveCount(rows + 1);

		// Nothing has been fetched yet: the sidebar list is text, on purpose. Said twice
		// because the two say different things. The first is what a traveller's connection
		// pays and cannot be read off the screen; the second is a shape no timing can
		// blur, and it still holds the line if the wait in `openStays` ever stops working.
		expect(requested, 'the map dialog fetched a photograph before anything was picked').toEqual([]);
		await expect(dialog.locator('img')).toHaveCount(0);

		const sidebar = dialog.getByTestId('stays-sidebar');
		const name = await points.nth(1).getAttribute('aria-label');
		await points.nth(1).click();

		await expect(sidebar.locator('.stays-detail-name')).toContainText(name!);
		await expect(points.nth(1)).toHaveAttribute('aria-pressed', 'true');

		// One photograph, for the one property the traveller asked about.
		const photos = sidebar.locator('.photo-carousel img');
		await expect(photos).toHaveCount(1);
		const drawn = (await photos.first().boundingBox())!;
		expect(drawn.width).toBeGreaterThan(120);
		expect(drawn.height).toBeGreaterThan(60);
		await expect
			.poll(() => photos.first().evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 })
			.toBeGreaterThan(0);

		await sidebar.getByRole('button', { name: /All \d+ stays/ }).click();
		await expect(sidebar.locator('.stays-row').first()).toBeVisible();
		await expect(points.nth(1)).toHaveAttribute('aria-pressed', 'false');
	});

	test('picking a stay in the sidebar re-bases every difference on it, without closing', async ({
		page
	}) => {
		await openStays(page);
		await page.locator('.stay-map-open').click();

		const dialog = page.locator('dialog.stays-dialog');
		const sidebar = dialog.getByTestId('stays-sidebar');
		// The last row, so the pick is definitely not the one already selected.
		const rows = sidebar.locator('.stays-row');
		const target = rows.last();
		const name = await target.locator('.stays-row-name').innerText();
		await target.click();

		await sidebar.getByRole('button', { name: 'Use this stay' }).click();

		// Still open: comparing two properties is one click each, which is the whole reason
		// the sidebar is in the dialog rather than replacing it.
		await expect(dialog).toBeVisible();
		await expect(sidebar.locator('.stays-tag.is-picked')).toHaveText('Current pick');

		// And the row that was picked now measures zero against itself, so every other
		// difference on screen is measured from the new one.
		await sidebar.getByRole('button', { name: /All \d+ stays/ }).click();
		const picked = sidebar.locator('.stays-row.is-picked');
		await expect(picked).toHaveCount(1);
		await expect(picked.locator('.stays-row-name')).toHaveText(name);
	});
});

test.describe("the tooltip's photographs (issue #307)", () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('the hover panel keeps every fact and loses the media box', async ({ page }) => {
		await openStays(page);

		// Off the strip first. `openStays` reaches this fixture by CLICKING this same target,
		// which leaves the pointer sitting on it, and a `hover()` that does not move the mouse
		// fires no `pointerenter`, so the panel never opens. It passed before #305 and #310
		// only because clicking shifted the layout enough to slide the strip under a
		// stationary cursor; the card is shorter and the page wider now, so it does not. A
		// person moves the pointer away and back, and this is that gesture.
		await page.mouse.move(0, 0);
		await page.locator('.trip-strip-hit-stopover').first().hover();
		const stub = page.locator('[role="tooltip"]').first();
		await expect(stub).toBeVisible();

		// The one thing removed. Measured on this same flow, same fixture and same viewport:
		// the panel stood 336x542 with a 302x189 media box in it, and stands 336x421 now.
		// The bound is half the viewport rather than that reading, because "a tooltip is for
		// a glance" is the property under test and 421px is only today's arithmetic.
		await expect(stub.locator('.photo-carousel')).toHaveCount(0);
		const box = (await stub.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(box.height, 'the tooltip is back to a panel with a picture in it').toBeLessThan(
			viewport.height / 2
		);

		// Everything else the block prints is still there: it is the media that was too
		// large for a tooltip, not the facts.
		await expect(stub.locator('.bed-name')).toBeVisible();
		await expect(stub.locator('.bed-rail')).toBeVisible();
		await expect(stub.locator('.bed-transfer')).toBeVisible();
	});

	test('the open property in the picker gained the carousel the tooltip lost', async ({ page }) => {
		await openStays(page);

		// The counter used to read "1 / 2" with no control that could reach the second
		// photograph. Now the arrows exist and the count moves.
		const carousel = customiser(page).locator('.stay-open-body .photo-carousel');
		await expect(carousel).toBeVisible();
		await expect(carousel.locator('.photo-count')).toHaveText('1 / 2');

		const box = (await carousel.boundingBox())!;
		expect(box.width).toBeGreaterThan(200);
		expect(box.height).toBeGreaterThan(100);

		await carousel.getByRole('button', { name: 'Next photo' }).click();
		await expect(carousel.locator('.photo-count')).toHaveText('2 / 2');
	});
});
