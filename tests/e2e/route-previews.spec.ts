import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import {
	customiser,
	openTimeline,
	pickStripSegment,
	pickTimelineSegment,
	visibleMapCanvases
} from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';
import { readWindowPng } from '../shared/read-png';
import { complainAboutPixels } from '../../src/lib/itinerary-map/basemap-canary';

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
 * The ground previews carry a photograph of the real basemap under the route, captured by
 * one hidden MapLibre instance shared by the page (`map-snapshot.svelte.ts`). That is a
 * second thing that can render at no size, or in the wrong place, or over the route instead
 * of under it, without looking broken from a semantic assertion. It gets measured the same
 * way.
 *
 * ## Issue #439: one leg at a time
 *
 * The row of three lived in the card's fold and showed a reader looking at one ride all of
 * them. The owner: "The transport maps should be moved to the right sidebar when the
 * respective timeline segment is selected." So the picture is in the trip inspector now,
 * there is one of it, and which one is whichever leg is selected.
 *
 * Losing the three-at-once view is the point of that issue rather than a casualty of it. The
 * rule it used to prove, that an itinerary with no origin location draws no origin preview,
 * is a property of `buildGroundLegPreviews` and is asserted in `previews.test.ts` where it
 * cannot depend on a layout. What is left here is what only a browser can answer: that the
 * picture the inspector shows is the leg it is about, that it has a real box, and that the
 * map behind it opens and closes exactly once.
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
		await openTimeline(page);
		await expect(page.locator('.ground-legs-item').first()).toBeVisible();

		// Counted, not assumed: a zero-context assertion passes for the wrong reason if the
		// page happens to be holding no previews. Two is what one card asks for since issue
		// #439 cut the row to the selected leg: the flight ornament on the card, and the one
		// ground picture in the inspector. `tools/probe-map-cost.mjs` is where the sixteen
		// live contexts Chromium allows are measured across card counts; a browser test
		// cannot conjure five itineraries out of two mocked flights.
		expect(await page.locator('.route-preview').count()).toBeGreaterThanOrEqual(2);

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

		const detail = customiser(page);
		const items = detail.locator('.ground-legs-item');
		// One, because the inspector opened on the stopover and the stopover has one picture.
		await expect(items).toHaveCount(1);

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

		// Still exactly one picture, for the leg still selected. A duplicate is what this test
		// is named after: the previews derive from the same `Itinerary` the press rewrites, so
		// a second copy appearing, or the only one vanishing, is the shape the defect takes.
		await expect(items).toHaveCount(1);
		await expect(detail.locator('.ground-leg')).toHaveCount(1);
		expect(await visibleMapCanvases(page)).toBe(0);
	});

	test('the inspector draws the leg it is about, one at a time, each with real size', async ({
		page
	}) => {
		// Issue #439's whole content, read as behaviour: pick a ground leg and its picture is
		// there, pick another and the picture is the other one. Three legs on this fixture,
		// walked in journey order, so a component that quietly kept drawing the first would
		// fail on the second.
		await search(page, BOTH_ENDS);
		await openTimeline(page);

		const detail = customiser(page);
		const legs = [
			['transfer-to-origin-airport', 'To the airport'],
			['transfer-to-hotel', 'The stopover'],
			['transfer-to-destination-location', 'To the destination']
		] as const;

		for (const [segment, label] of legs) {
			await pickTimelineSegment(page, segment);
			await expect(detail.locator('.ground-legs-item')).toHaveCount(1);
			await expect(detail.getByText(label, { exact: true })).toBeVisible();

			const box = await detail.locator('.ground-legs-item .route-preview').boundingBox();
			expect(box, `${label} must have a bounding box`).not.toBeNull();
			expect(box!.width, `${label} width`).toBeGreaterThan(40);
			expect(box!.height, `${label} height`).toBeGreaterThan(30);
		}

		// The ride out to the bed and the ride back are one hop drawn twice, so they share a
		// picture. Selecting the second must not produce a second one.
		await pickTimelineSegment(page, 'transfer-to-connection-airport');
		await expect(detail.locator('.ground-legs-item')).toHaveCount(1);
		await expect(detail.getByText('The stopover', { exact: true })).toBeVisible();
	});

	test('a step that is not a ground leg draws no map, and offers no button pretending to', async ({
		page
	}) => {
		// The other half of #439. A reader on a flight or a wait is shown nothing rather than
		// whichever picture happened to be first, and a trip with ground legs must not fall
		// back to the "Open the route map" button either: that button exists for the trip that
		// has no ground leg at all, and offering it here would put a control on every flight
		// panel.
		await search(page, BOTH_ENDS);
		await openTimeline(page);

		await pickTimelineSegment(page, 'outbound-flight');
		await expect(customiser(page).getByRole('radiogroup', { name: /Outbound/ })).toBeVisible();
		await expect(customiser(page).locator('.ground-leg')).toHaveCount(0);
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

		const items = customiser(page).locator('.ground-legs-item');
		// Each leg in turn, since issue #439 draws one at a time. Every one of them has to
		// survive the capture, and a leg that only ever rendered while two others shared the
		// row would go untested.
		for (const segment of [
			'transfer-to-origin-airport',
			'transfer-to-hotel',
			'transfer-to-destination-location'
		]) {
			await pickTimelineSegment(page, segment);
			await expect(items).toHaveCount(1);
			const map = items.first().locator('.inert-map');
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
			expect(mapBox.width, `${segment} map width`).toBeGreaterThan(40);
			// Edge to edge on the box, not roughly. The route is stroked against the same
			// rectangle the picture was captured for, so a picture inset by a few pixels is
			// a map offset from the road it is drawing.
			expect(pictureBox.x, `${segment} picture left`).toBeCloseTo(mapBox.x, 0);
			expect(pictureBox.y, `${segment} picture top`).toBeCloseTo(mapBox.y, 0);
			expect(pictureBox.width, `${segment} picture width`).toBeCloseTo(mapBox.width, 0);
			expect(pictureBox.height, `${segment} picture height`).toBeCloseTo(mapBox.height, 0);

			// It decoded, rather than leaving a broken-image box of exactly the right size.
			// That is what a failed capture or a tainted canvas looks like from out here,
			// and every assertion above passes while it is true.
			const decoded = await picture.evaluate((img) => (img as HTMLImageElement).naturalWidth);
			expect(decoded, `${segment} picture decoded`).toBeGreaterThan(0);

			// And what it decoded is a drawing rather than a fill (#443). Every assertion
			// above this line passes against a flat rectangle, which is what the mocked
			// basemap was until the shared fixture started drawing a street grid: it inked
			// 0.0000 of its pixels, the same number a style with no layers at all measures,
			// so this whole test was a test of a box's geometry and never of a map.
			//
			// Judged by `complainAboutPixels`, the pixel half of the instrument the live
			// basemap canary uses, at thresholds read off sixteen real CARTO renders rather
			// than picked. One opinion about what a map looks like, not two.
			const captured = await picture.evaluate((img) => (img as HTMLImageElement).src);
			expect(captured.startsWith('data:image/png;base64,'), `${segment} picture is a capture`).toBe(true);
			const verdict = complainAboutPixels(
				await readWindowPng(Buffer.from(captured.slice('data:image/png;base64,'.length), 'base64'))
			);
			expect(
				verdict.complaints,
				`${segment} basemap picture: ${verdict.complaints.join('; ')} ` +
					`(inkShare ${verdict.stats.inkShare.toFixed(4)}, ` +
					`lumaSpread ${verdict.stats.lumaSpread.toFixed(4)})`
			).toEqual([]);

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
			expect(onTop, `${segment} draws the route over the basemap`).toBe(true);
		}

		// CARTO's terms, satisfied once for the row rather than once per picture.
		await expect(customiser(page).locator('.ground-legs-credit')).toHaveText('© OpenStreetMap, © CARTO');
	});

	test('a preview with no basemap draws the coast instead, and still shows the route', async ({ page }) => {
		// What a traveller sees when the map cannot be had. This is the assertion the first
		// build of this feature was missing, and it was missing in the direction that
		// matters: the picture arrived in every test, so nothing ever rendered the case the
		// whole design rests on being survivable.
		await search(page, BOTH_ENDS, { basemap: false });
		await openTimeline(page);

		const items = customiser(page).locator('.ground-legs-item');

		// No picture, rather than a picture of nothing. A style that will not load still
		// goes idle and still captures, as a flat rectangle, and caching that would be a
		// worse preview than this drawing and a permanent one.
		await expect(page.locator('img.inert-map-picture')).toHaveCount(0);

		// Each leg in turn, since issue #439 draws one at a time. A leg that only ever
		// rendered while two others shared the row would go untested.
		for (const segment of [
			'transfer-to-origin-airport',
			'transfer-to-hotel',
			'transfer-to-destination-location'
		]) {
			await pickTimelineSegment(page, segment);
			await expect(items).toHaveCount(1);
			const preview = items.first().locator('.route-preview');

			// The land tile arrives on its own schedule, so this waits for it rather than
			// assuming it.
			//
			// `.rp-land` without an element name on purpose. `RoutePreview` draws land as
			// `<path>` normally and as a masked `<rect>` wherever a country boundary crosses
			// the window, and two of these three take the second branch. A locator naming
			// `path` passes on the one leg that has no border in it and silently ignores the
			// two that do, which is the wrong two: the bordered ones carry more of the
			// picture.
			await expect
				.poll(() => preview.locator('.rp-land').count(), {
					message: `${segment} must fall back to the drawn coast`,
					timeout: 30_000
				})
				.toBe(1);

			// And the route is still on it. A fallback that lost the one line these pictures
			// exist to draw would be no better than the blank box.
			const leg = preview.locator('path.rp-leg').first();
			await expect(leg).toBeVisible();
			const legBox = (await leg.boundingBox())!;
			expect(legBox.width + legBox.height, `${segment} route`).toBeGreaterThan(20);
			const box = (await preview.boundingBox())!;
			expect(box.width, `${segment} width`).toBeGreaterThan(40);
			expect(box.height, `${segment} height`).toBeGreaterThan(30);
		}

		// And the renderer let go of its context rather than holding one open for a map it
		// could not draw. The timeout has to clear `IDLE_RELEASE_MS`, which is deliberately
		// several seconds so a page being scrolled does not rebuild an instance per card.
		await expect.poll(() => page.locator('canvas.maplibregl-canvas').count(), { timeout: 20_000 }).toBe(0);
	});

	test('a leg the trip never had draws nothing, and the ones it has still draw', async ({ page }) => {
		// The owner's rule, read through issue #439's one-at-a-time panel: "if one is not
		// existing, for example origin location was not set, the map for that part is not
		// shown". With three pictures in a row that showed as two, slightly wider; with one
		// picture it shows as none at all for that leg, and the panel says why in words
		// instead (`unroutedLegNote`).
		//
		// The row-width half of the old assertion moved to `previews.test.ts`, where the
		// "only the legs this itinerary has" rule belongs and cannot depend on a layout.
		await search(page, { toLoc: BOTH_ENDS.toLoc });
		await openTimeline(page);

		const detail = customiser(page);

		await pickTimelineSegment(page, 'transfer-to-hotel');
		await expect(detail.locator('.ground-legs-item')).toHaveCount(1);

		// This search names no origin location, so there is no ride to the airport and no
		// picture of one. The picture the previous selection drew must go, rather than
		// staying on screen under a step it does not belong to.
		await pickTimelineSegment(page, 'origin-waiting');
		await expect(detail.locator('.ground-leg')).toHaveCount(0);
		await expect(detail.getByText('To the airport', { exact: true })).toHaveCount(0);
	});

	test('tapping a preview opens one map, and closing it takes the map away and gives focus back', async ({
		page
	}) => {
		await search(page, BOTH_ENDS);
		await openTimeline(page);

		const trigger = customiser(page).locator('.ground-leg').first();
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

		const trigger = customiser(page).locator('.ground-leg').first();
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

		const preview = customiser(page).locator('.ground-leg').first();
		const dialog = page.locator('dialog.route-dialog');

		// One open and close proves teardown runs. Ten prove it runs every time, which is
		// the shape this defect would have: nothing visibly wrong until Chromium evicts the
		// oldest of sixteen live contexts, long after the change that caused it.
		for (let round = 0; round < 10; round++) {
			await preview.click();
			await expect(dialog).toBeVisible();
			await expect.poll(() => visibleMapCanvases(page)).toBe(1);
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect.poll(() => visibleMapCanvases(page)).toBe(0);
		}
	});

	test('clearing the selection inside the map does not close the map', async ({ page }) => {
		// Found twice while wiring issue #439, before it could ship, and the second one is why
		// the dialog is the page's rather than `GroundLegPreviews`'s.
		//
		// The map inside the dialog writes the page's selection: "Show whole route" clears it,
		// and clicking a flight line sets a segment with no ground picture. An inspector that
		// rendered the previews only when the selection had a picture unmounted the dialog on
		// either. And on a phone the sheet itself only mounts while a segment is selected, so
		// even a preview that stayed put would have gone down with its container. Both closed
		// the map under the press that asked for more of it.
		await search(page, BOTH_ENDS);
		await openTimeline(page);
		await pickTimelineSegment(page, 'transfer-to-hotel');

		await customiser(page).locator('.ground-leg').click();
		const dialog = page.locator('dialog.route-dialog');
		await expect(dialog).toBeVisible();

		await dialog.getByRole('button', { name: 'Show whole route' }).click();

		await expect(dialog).toBeVisible();
		await expect(dialog.locator('.map-status')).toContainText('Showing the whole route');
		await expect.poll(() => visibleMapCanvases(page)).toBe(1);

		// And it still closes the ordinary way afterwards, rather than being left mounted by
		// whatever kept it alive.
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect.poll(() => visibleMapCanvases(page)).toBe(0);
	});

	test('the map opened from the phone sheet outlives the sheet', async ({ page }) => {
		// The same defect one container up, and the reason the dialog is rendered by the page.
		// The sheet mounts only while a segment is selected (`sheetIsOpen`), so "Show whole
		// route" used to close the sheet and unmount the map with it. A press inside the
		// dialog must not read as a press outside the sheet either.
		await page.setViewportSize({ width: 375, height: 812 });
		await search(page, BOTH_ENDS);
		await openTimeline(page);
		await pickTimelineSegment(page, 'transfer-to-hotel');

		await customiser(page).locator('.ground-leg').click();
		const dialog = page.locator('dialog.route-dialog');
		await expect(dialog).toBeVisible();

		await dialog.getByRole('button', { name: 'Show whole route' }).click();

		await expect(dialog).toBeVisible();
		await expect.poll(() => visibleMapCanvases(page)).toBe(1);

		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect.poll(() => visibleMapCanvases(page)).toBe(0);
	});

	test('closing the panel takes the map with it, and does not spring it open again', async ({
		page
	}) => {
		// The map is the page's since issue #439, and a flag the page holds is a flag the page
		// has to clear. Left set, it would hide the map when the panel closed and then reopen
		// it under the next segment somebody picked, which is not a thing a traveller asked
		// for twice.
		await search(page, BOTH_ENDS);
		await openTimeline(page);
		await pickTimelineSegment(page, 'transfer-to-hotel');
		await customiser(page).locator('.ground-leg').click();
		await expect(page.locator('dialog.route-dialog')).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(page.locator('dialog.route-dialog')).toHaveCount(0);
		await page.getByRole('button', { name: 'Done' }).click();

		await pickStripSegment(page, 'stopover');
		await expect(customiser(page)).toHaveAttribute('data-segment', 'free-time');
		await expect(page.locator('dialog.route-dialog')).toHaveCount(0);
	});

	test('the dialog opens framed on the leg that was tapped', async ({ page }) => {
		await search(page, BOTH_ENDS);
		await openTimeline(page);

		// The stopover leg, which is not the first one in journey order, so a component that
		// drew whichever picture happened to be first would fail here rather than
		// coincidentally matching.
		await pickTimelineSegment(page, 'transfer-to-hotel');
		await customiser(page).locator('.ground-leg').click();

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
