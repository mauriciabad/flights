import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline, pickTimelineSegment, visibleMapCanvases } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

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
 * bought: the whole page holds one WebGL context at most while no dialog is open, the
 * dialog adds exactly one more, and closing it takes that one away. A leak there does not
 * break anything visible until a traveller's ninth dialog, which is exactly the kind of
 * defect no one traces back.
 *
 * The three ground previews now carry a photograph of the real basemap under the route,
 * captured by one hidden MapLibre instance shared by the page
 * (`map-snapshot.svelte.ts`). That is a second thing that can render at no size, or in
 * the wrong place, or over the route instead of under it, without looking broken from a
 * semantic assertion. It gets measured the same way.
 *
 * Fare values come from `support/fixture-markers.ts` for the reason that file explains.
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

/** The two ends are opt-in: `search/pipeline.ts` only asks a transfer provider about them
 *  when the query names a location, and an itinerary with no origin location is exactly
 *  the "then show two, slightly wider" case the owner asked for. */
async function search(
	page: Page,
	ends: { fromLoc?: string; toLoc?: string },
	{ beds = false, basemap = true }: { beds?: boolean; basemap?: boolean } = {}
): Promise<void> {
	await mockAllKeylessProviders(page.context());
	// `mockAllKeylessProviders` answers Hostelworld with an empty city, which is what every
	// other test in this file wants. The transport-press test needs a second bed to swap to,
	// because that is the only state the press is offered in. Registered after, so it wins:
	// Playwright matches route handlers in reverse registration order.
	if (beds) {
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna-both-far.json'
		);
	}
	await routeRyanairFlights(page.context(), BCN_VIE_TLL);
	// No basemap route here on purpose. `fixtures.ts` registers `mockMapStyle` for every
	// test, and this file is the one that asserts on the picture a preview shows, so it
	// wants that style rather than a local copy which could drift from it. A copy did
	// drift: it served a document with no layers, so every capture in this file was of a
	// blank map and every assertion about a picture still passed.
	//
	// `basemap: false` takes the host away instead, which is the traveller on a train with
	// no signal, or CARTO having a bad afternoon. Registered last, so it wins.
	if (!basemap) {
		await page.context().route('https://basemaps.cartocdn.com/**', (route) => route.abort());
	}

	const params = new URLSearchParams({
		dep: '2027-03-08',
		arr: '2027-03-27',
		from: 'BCN',
		to: 'TLL',
		...ends
	});
	await page.goto(`/results/?${params}`);
	await waitForSearchToSettle(page, { timeout: 20_000 });
}

const BOTH_ENDS = {
	fromLoc: 'FIXTURE start point@41.3851,2.1734',
	toLoc: 'FIXTURE end point@59.4370,24.7536'
};

test.describe('frozen route previews (issue #280)', () => {
	test('the card carries a flight picture with real size, drawn against a direct flight', async ({
		page
	}) => {
		await search(page, BOTH_ENDS);

		const card = page.locator('.result-card').first();
		const picture = card.locator('.flight-shape .route-preview');
		await expect(picture).toBeVisible();

		// Not "an svg exists". A drawing nobody can see is the defect this asserts against.
		const box = await picture.boundingBox();
		expect(box, 'the flight picture must have a bounding box').not.toBeNull();
		expect(box!.width).toBeGreaterThan(60);
		expect(box!.height).toBeGreaterThan(40);

		// Three strokes drawn: the two flown legs, and the direct line that is not one. The
		// dashed baseline is the thing worth pinning, because it is the one line on the card
		// that no carrier flies. Issue #305 removed the caption that used to say so in words
		// at the owner's request ("The flight map should not have the text"), so the stroke is
		// now the only place that distinction lives and `RoutePreview`'s own header records
		// why the two strokes must never be tidied into one.
		await expect(card.locator('.flight-shape path.rp-leg')).toHaveCount(2);
		await expect(card.locator('.flight-shape path.rp-baseline')).toHaveCount(1);
		const dash = await card
			.locator('.flight-shape path.rp-baseline')
			.evaluate((path) => getComputedStyle(path).strokeDasharray);
		expect(dash, 'the direct line must not read as a flown leg').not.toBe('none');

		// And #305's other half: the grey tray is gone, so the arcs sit on the card's own
		// surface rather than on a rectangle that reads as a screenshot of a map.
		const background = await picture.evaluate((svg) => getComputedStyle(svg).backgroundColor);
		expect(background).toBe('rgba(0, 0, 0, 0)');
	});

	test('the previews share one WebGL context, however many cards are on screen', async ({ page }) => {
		await search(page, BOTH_ENDS);

		await expect(page.locator('.result-card').first()).toBeVisible();
		// Issue #278: every card, one at a time. The unfold control is the trip strip's own
		// stopover caption, so its accessible name carries the city and cannot be matched by
		// a fixed string; the class is what identifies it.
		for (const unfold of await page.locator('.trip-strip-unfold').all()) {
			await unfold.click();
		}
		await expect(page.locator('.ground-legs-item').first()).toBeVisible();

		// Counted, not assumed: a zero-context assertion passes for the wrong reason if the
		// page happens to be holding no previews. This fixture yields one card, so four is
		// what one card asks for, and four live contexts per card is the arithmetic that
		// puts a results page over Chromium's sixteen at the fifth card.
		// `tools/probe-map-cost.mjs` is where that ceiling is measured across card counts;
		// a browser test cannot conjure five itineraries out of two mocked flights.
		expect(await page.locator('.route-preview').count()).toBeGreaterThanOrEqual(4);

		// One is the number because there is one renderer for the page, not one per
		// preview and not one per card. Chromium evicts the oldest of more than sixteen
		// live contexts, so a preview that made its own would put the ceiling at four
		// cards; `tools/probe-map-cost.mjs` is where that is measured across card counts.
		//
		// Sampled across the whole settle rather than read once. The renderer is built when
		// the first preview asks and released when the queue empties, so a single reading
		// could land either side of a leak and prove nothing.
		let peak = 0;
		for (let sample = 0; sample < 30; sample++) {
			peak = Math.max(peak, await page.locator('canvas.maplibregl-canvas').count());
			await page.waitForTimeout(100);
		}
		expect(peak, 'one shared renderer, never one per preview').toBeLessThanOrEqual(1);

		// And none of them is on a card. Every map a traveller can see is still inside a
		// dialog, and no dialog is open.
		expect(await visibleMapCanvases(page)).toBe(0);
	});

	test('asking about public transport neither strips nor duplicates a preview', async ({ page }) => {
		// #282 added an on-demand timetable lookup that can change a transfer row's shape
		// after a press. These previews derive from the same `Itinerary`, so they follow it,
		// and the concern is whether following it can leave the row wrong: a leg vanishing,
		// or a second copy of one appearing.
		//
		// Issue #372: this looked for the button inside `.result-detail` and skipped the press
		// when it found none, and #278 had moved every picker out of that card into
		// `SegmentCustomiser`. The count was zero on every run since, so the gesture this test
		// is named after had never once happened. The press is unconditional now, and the two
		// things it genuinely depends on are asserted ahead of it rather than silently
		// skipped, which is #337's rule: a wait satisfied by absence proves nothing.
		await search(page, BOTH_ENDS, { beds: true });
		await openTimeline(page);

		const detail = page.locator('.result-detail');
		const items = detail.locator('.ground-legs-item');
		await expect(items).toHaveCount(3);

		// First condition. `canCheckTransit` (SegmentCustomiser.svelte) offers the press only
		// for a bed the search never routed to, since the search's own bed already has its
		// timetable and a second lookup would spend two requests to learn what is on screen.
		await pickTimelineSegment(page, 'free-time');
		const otherBed = customiser(page).locator('.alt-card', { hasText: 'FIXTURE Far Lodge' });
		await expect(otherBed).toBeVisible();
		await otherBed.click();
		await expect(detail.locator('.stopover')).toContainText('FIXTURE Far Lodge');

		// Second condition. The button sits under the notice that says why there is anything
		// to ask about, and `not-asked` is the answer that makes the offer real.
		await pickTimelineSegment(page, 'transfer-to-hotel');
		const notice = customiser(page).getByTestId('transit-notice');
		await expect(notice).toHaveAttribute('data-transit-answer', 'not-asked');

		const check = customiser(page).getByRole('button', { name: 'Check public transport' });
		await expect(check).toBeVisible();
		await check.click();

		// What the press bought, asserted on the picker rather than on the button or the
		// notice. Both of those are gone by design once the answer lands: pressing writes
		// `draft.transitChecks`, `canCheckTransit` goes false and the control unmounts, and
		// the notice exists only to say nobody asked about the bus. A row offering the bus is
		// the durable evidence, and it is what the traveller pressed for.
		//
		// Measured on this fixture: the press sends exactly the two `/plan` requests
		// `TRANSIT_LEGS_TO_A_PROPERTY` names, both answered 200 by `transitous/plan.json`.
		await expect(customiser(page).locator('.picker-row', { hasText: 'Public transport' })).toBeVisible({
			timeout: 20_000
		});
		await expect(notice).toHaveCount(0);

		await expect(items).toHaveCount(3);
		// Keyed on a fixed set of three preview ids, so a duplicate is not representable;
		// this checks the row is still one preview per leg and not one per timeline row.
		await expect(detail.locator('.ground-leg')).toHaveCount(3);
		expect(await visibleMapCanvases(page)).toBe(0);
	});

	test('three ground legs render three previews, each with real size', async ({ page }) => {
		await search(page, BOTH_ENDS);
		await openTimeline(page);

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

	test('each ground preview lays a real basemap picture under its route, in its own box', async ({
		page
	}) => {
		// The owner asked for "a normal map but inert" here, and the three ways this goes
		// wrong without looking wrong are a picture at no size, a picture offset from the
		// drawing it belongs to, and a picture painted over the route instead of under it.
		// So this measures boxes, the same as everything else in this file.
		await search(page, BOTH_ENDS);
		await openTimeline(page);

		const items = page.locator('.result-detail .ground-legs-item');
		await expect(items).toHaveCount(3);

		for (let index = 0; index < 3; index++) {
			const map = items.nth(index).locator('.inert-map');
			const picture = map.locator('img.inert-map-picture');
			await map.scrollIntoViewIfNeeded();

			// The wait is on the picture arriving rather than on a number of seconds: the
			// preview paints its solid fill first and swaps the map in when the shared
			// renderer reaches its window, which is this app's "stale first, then fresh"
			// rule applied to a drawing.
			await expect(picture).toBeVisible({ timeout: 30_000 });
			// One picture, never a grid. A grid of raster tiles is the other way to build
			// this and it is the one that needs an API key.
			await expect(picture).toHaveCount(1);

			const mapBox = (await map.boundingBox())!;
			const pictureBox = (await picture.boundingBox())!;
			expect(mapBox.width, `preview ${index} map width`).toBeGreaterThan(40);
			// Edge to edge on the box, not roughly. The route is stroked against the same
			// rectangle the picture was captured for, so a picture inset by a few pixels is
			// a map offset from the road it is drawing.
			expect(pictureBox.x, `preview ${index} picture left`).toBeCloseTo(mapBox.x, 0);
			expect(pictureBox.y, `preview ${index} picture top`).toBeCloseTo(mapBox.y, 0);
			expect(pictureBox.width, `preview ${index} picture width`).toBeCloseTo(mapBox.width, 0);
			expect(pictureBox.height, `preview ${index} picture height`).toBeCloseTo(mapBox.height, 0);

			// It decoded, rather than leaving a broken-image box of exactly the right size.
			// That is what a failed capture or a tainted canvas looks like from out here,
			// and every assertion above passes while it is true.
			const decoded = await picture.evaluate((img) => (img as HTMLImageElement).naturalWidth);
			expect(decoded, `preview ${index} picture decoded`).toBeGreaterThan(0);

			// The route is over the map, not under it. Not a detail: the picture is
			// absolutely positioned and the drawing is not, and a positioned element paints
			// above a static sibling whatever the source order says, so the first build of
			// this component hid the whole route behind the map. Everything above passed
			// while it did.
			const onTop = await map.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
				return hit !== null && hit.closest('.route-preview') !== null;
			});
			expect(onTop, `preview ${index} draws the route over the basemap`).toBe(true);
		}

		// CARTO's terms, satisfied once for the row rather than once per picture.
		await expect(page.locator('.result-detail .ground-legs-credit')).toHaveText('© OpenStreetMap, © CARTO');
	});

	test('a preview with no basemap draws the coast instead, and still shows the route', async ({ page }) => {
		// What a traveller sees when the map cannot be had. This is the assertion the first
		// build of this feature was missing, and it was missing in the direction that
		// matters: the picture arrived in every test, so nothing ever rendered the case the
		// whole design rests on being survivable.
		await search(page, BOTH_ENDS, { basemap: false });
		await openTimeline(page);

		const items = page.locator('.result-detail .ground-legs-item');
		await expect(items).toHaveCount(3);

		// No picture, rather than a picture of nothing. A style that will not load still
		// goes idle and still captures, as a flat rectangle, and caching that would be a
		// worse preview than this drawing and a permanent one.
		await expect(page.locator('img.inert-map-picture')).toHaveCount(0);

		// Every one of them draws ground, and the land tile arrives on its own schedule so
		// this waits for it rather than assuming it.
		//
		// `.rp-land` without an element name on purpose. `RoutePreview` draws land as
		// `<path>` normally and as a masked `<rect>` wherever a country boundary crosses the
		// window, and two of these three take the second branch. A locator naming `path`
		// passes on the one preview that has no border in it and silently ignores the two
		// that do, which is the wrong two: the bordered ones carry more of the picture.
		await expect
			.poll(() => page.locator('.result-detail .ground-legs-row .rp-land').count(), {
				message: 'every preview must fall back to the drawn coast',
				timeout: 30_000
			})
			.toBe(3);

		for (let index = 0; index < 3; index++) {
			const preview = items.nth(index).locator('.route-preview');
			await expect(preview.locator('.rp-land')).toHaveCount(1);
			// And the route is still on it. A fallback that lost the one line these pictures
			// exist to draw would be no better than the blank box.
			const leg = preview.locator('path.rp-leg').first();
			await expect(leg).toBeVisible();
			const legBox = (await leg.boundingBox())!;
			expect(legBox.width + legBox.height, `preview ${index} route`).toBeGreaterThan(20);
			const box = (await preview.boundingBox())!;
			expect(box.width, `preview ${index} width`).toBeGreaterThan(40);
			expect(box.height, `preview ${index} height`).toBeGreaterThan(30);
		}

		// And the renderer let go of its context rather than holding one open for a map it
		// could not draw. The timeout has to clear `IDLE_RELEASE_MS`, which is deliberately
		// several seconds so a page being scrolled does not rebuild an instance per card.
		await expect.poll(() => page.locator('canvas.maplibregl-canvas').count(), { timeout: 20_000 }).toBe(0);
	});

	test('a missing origin location leaves two previews, each wider than three would be', async ({ page }) => {
		await search(page, { toLoc: BOTH_ENDS.toLoc });
		await openTimeline(page);

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
		await openTimeline(page);

		const detail = page.locator('.result-detail');
		const trigger = detail.locator('.ground-leg').first();
		expect(await visibleMapCanvases(page)).toBe(0);

		await trigger.click();

		const dialog = page.locator('dialog.route-dialog');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('region', { name: /Route map/ })).toBeVisible();
		// Exactly one, never one per preview.
		await expect.poll(() => visibleMapCanvases(page)).toBe(1);

		// Near-fullscreen: a fixed margin and nothing more.
		const dialogBox = (await dialog.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(dialogBox.width).toBeGreaterThan(viewport.width * 0.8);
		expect(dialogBox.width).toBeLessThan(viewport.width);

		await page.keyboard.press('Escape');

		await expect(dialog).toHaveCount(0);
		// The instance is gone, not merely hidden. A dialog that leaked one per open would
		// walk a session into the same sixteen-context ceiling, one dialog at a time.
		await expect.poll(() => visibleMapCanvases(page)).toBe(0);
		await expect(trigger).toBeFocused();
	});

	test('the close button returns to the results the same way Escape does', async ({ page }) => {
		await search(page, BOTH_ENDS);
		await openTimeline(page);

		const trigger = page.locator('.result-detail .ground-leg').first();
		await trigger.click();

		const dialog = page.locator('dialog.route-dialog');
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: 'Close' }).click();

		await expect(dialog).toHaveCount(0);
		await expect.poll(() => visibleMapCanvases(page)).toBe(0);
		await expect(trigger).toBeFocused();
	});

	test('ten opens and closes leave no map behind', async ({ page }) => {
		await search(page, BOTH_ENDS);
		await openTimeline(page);

		const previews = page.locator('.result-detail .ground-leg');
		const dialog = page.locator('dialog.route-dialog');

		// One open and close proves teardown runs. Ten prove it runs every time, which is
		// the shape this defect would have: nothing visibly wrong until Chromium evicts the
		// oldest of sixteen live contexts, long after the change that caused it.
		for (let round = 0; round < 10; round++) {
			await previews.nth(round % 3).click();
			await expect(dialog).toBeVisible();
			await expect.poll(() => visibleMapCanvases(page)).toBe(1);
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect.poll(() => visibleMapCanvases(page)).toBe(0);
		}
	});

	test('the dialog opens framed on the leg that was tapped', async ({ page }) => {
		await search(page, BOTH_ENDS);
		await openTimeline(page);

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
