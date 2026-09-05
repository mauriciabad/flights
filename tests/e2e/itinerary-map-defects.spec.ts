import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { openTimeline } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #141: three map defects, each with an assertion that fails on the code before the
 * fix rather than a screenshot that looks about right.
 *
 * The itinerary this builds has no stay priced, because that is the condition all three
 * defects need: with no bed, the stopover point falls back to the connection airport's own
 * coordinates. BCN -> VIE -> TLL on keyless Ryanair, with the fixture-marker figures every
 * mock in this suite uses, so an escaped payload reads as nonsense rather than as a working
 * search.
 *
 * Until issue #198 the two connection-side transfer legs did not exist either, because a
 * bedless stopover had nowhere to route to unless #162 had a hand-checked centre for the
 * airport, and Vienna was not one of the ten. They exist now: VIE has a generated centre,
 * so both legs run between the airport and the city. Claim 2 below is where that shows.
 *
 * The three claims:
 *
 * 1. The stopover marker takes a real click. `locator.click()` with no `force` is the
 *    assertion: Playwright refuses to click an element another element covers, which is
 *    exactly how the issue was found ("subtree intercepts pointer events", 60 retries).
 * 2. Selecting a transfer row always says what the map is doing. The `role="status"` line
 *    used to go empty, which a screen reader hears as nothing at all.
 * 3. A re-render of the whole style leaves the camera alone. Measured off MapLibre's own
 *    marker transforms, which move if and only if the camera does. This was the
 *    waiting-time stepper until issue #280 put the map behind a modal and took a timeline
 *    control out of reach while it is open; the colour-scheme flip that replaced it drives
 *    the same effect through a heavier path.
 *
 * Since issue #280 all three claims are made against the map inside `RouteMapDialog`,
 * reached by tapping a frozen preview. The component under test is the same one.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** Vienna International and Tallinn Airport, the two coordinates this app resolves out of
 *  its own OurAirports dataset for these IATA codes. Their longitude separation is the
 *  baseline the zoom check below measures against. */
const VIE_LNG = 16.5697;
const TLL_LNG = 24.8328;

/**
 * MapLibre positions every DOM marker by writing `translate(Xpx, Ypx)` onto the element,
 * so two markers at known longitudes give away the map's scale without this test needing a
 * handle on the map object. Pixels per degree of longitude is `512 * 2 ** zoom / 360` in
 * Web Mercator, which is a big enough gap between zoom 10 and zoom 13 (1456 against 11651)
 * that no rounding or padding could confuse the two.
 */
async function pixelsPerLongitudeDegree(page: Page): Promise<number> {
	const positions = await page.evaluate(() => {
		function translationOf(label: string): number {
			const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
			if (!element) throw new Error(`no marker labelled ${label}`);
			const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(element.style.transform);
			if (!match) throw new Error(`no translate on ${label}: ${element.style.transform}`);
			return Number(match[1]);
		}
		return { vie: translationOf('Vienna (VIE)'), tll: translationOf('Tallinn (TLL)') };
	});
	return Math.abs(positions.tll - positions.vie) / Math.abs(TLL_LNG - VIE_LNG);
}

/** Every marker's on-screen position at once: unchanged means the camera did not move. */
function markerTransforms(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>('.itinerary-marker')).map(
			(element) => `${element.getAttribute('aria-label')}@${element.style.transform}`
		)
	);
}

async function openDetail(page: Page, options: { originLocation?: boolean } = {}) {
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
	// A sourceless style still fires MapLibre's `load`, which is all the markers need, and
	// keeps real vector tiles out of a test that is about DOM markers and a caption.
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);

	// `fromLoc` is opt-in: only the marker-collision check below needs a second point near
	// an airport, and every other check reads better on the plainest itinerary that shows
	// the defect.
	const origin = options.originLocation
		? '&fromLoc=' + encodeURIComponent('Barcelona centre@41.3870,2.1700')
		: '';
	await page.goto(`/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL${origin}`);
	await waitForSearchToSettle(page, { timeout: 20_000 });
	await openTimeline(page);

	const detail = page.locator('.result-detail');
	// Issue #280 moved the map off the panel and into a dialog behind the frozen previews,
	// so every claim below is now made against the dialog. The defects themselves are
	// unchanged: they are `ItineraryMap`'s, and that component is the same one, on a bigger
	// surface. Opening the stopover preview is the traveller's own way in.
	await detail.locator('.ground-leg').first().click();

	const dialog = page.locator('dialog.route-dialog');
	await expect(dialog.getByRole('region', { name: /Route map/ })).toBeVisible();
	// The stopover marker only exists once the connection airport has resolved out of the
	// dataset and the model has been drawn.
	await expect(dialog.locator('.itinerary-marker[aria-label="Stopover in Vienna"]')).toBeVisible();
	return dialog;
}

test.describe('itinerary map defects (issue #141)', () => {
	test('the stopover marker takes a click even though it shares a coordinate with the airport', async ({
		page
	}) => {
		const dialog = await openDetail(page);

		const stopover = dialog.locator('.itinerary-marker[aria-label="Stopover in Vienna"]');
		const airport = dialog.locator('.itinerary-marker[aria-label="Vienna (VIE)"]');

		// Both are at the connection airport's coordinates, and before this fix they were
		// drawn on top of each other with the airport pill last, so it took every click.
		const stopoverBox = await stopover.boundingBox();
		const airportBox = await airport.boundingBox();
		expect(stopoverBox).not.toBeNull();
		expect(airportBox).not.toBeNull();
		const gap = airportBox!.y - (stopoverBox!.y + stopoverBox!.height);
		expect(gap, 'the stopover marker sits clear above the airport pill').toBeGreaterThan(0);

		// No `force`: this is the assertion. It is what failed for 60 retries in the issue.
		await stopover.click();

		await expect(stopover).toHaveAttribute('aria-pressed', 'true');
		await expect(dialog.locator('.map-status')).toContainText('Showing Stopover in Vienna.');

		// The airport pill underneath is still its own control, not collateral damage.
		await airport.click();
		await expect(airport).toHaveAttribute('aria-pressed', 'true');
		await expect(stopover).toHaveAttribute('aria-pressed', 'false');

		// A timeline row is inert under a modal, so the shared `ItinerarySegmentId` contract
		// (segment-id.ts) is checked where it now pays off: close the dialog, and the row for
		// the leg the traveller ended up looking at is the one highlighted underneath.
		await page.keyboard.press('Escape');
		await expect(page.locator('.result-detail [data-segment="connection-waiting"]')).toHaveAttribute(
			'aria-current',
			'true'
		);
	});

	test('the stack is re-measured when the camera moves, and only where markers collide', async ({
		page
	}) => {
		// The first version of this fix stacked markers sharing a *coordinate*, and the live
		// run on the issue's own route showed that is not the case that matters: Bergamo's
		// centre is 5 km from BGY, and at the zoom that frames a whole trip 5 km is a third
		// of a pixel. Collision is a screen fact, so it is re-measured on `moveend`.
		const dialog = await openDetail(page, { originLocation: true });
		// The preview opened the map on one leg (issue #280); this claim is about the zoom
		// that frames the whole trip, which is one button away inside the dialog.
		await dialog.getByRole('button', { name: 'Show whole route' }).click();
		await page.waitForTimeout(900);
		// Two points 12 km apart: the traveller's own starting point and the runway it feeds.
		// Distinct coordinates, and one pixel apart at the zoom that frames BCN to TLL.
		const start = dialog.locator('.itinerary-marker[aria-label="Barcelona centre"]');
		const barcelona = dialog.locator('.itinerary-marker[aria-label="Barcelona (BCN)"]');
		const tallinn = dialog.locator('.itinerary-marker[aria-label="Tallinn (TLL)"]');
		await expect(start).toBeVisible();

		// The lift a marker is carrying, in pixels, published as its z-index: a marker with
		// nothing near it is never moved, so it stays at zero.
		const liftOf = (marker: typeof start) => marker.evaluate((el) => Number(el.style.zIndex || 0));

		await expect.poll(() => liftOf(start), { timeout: 5_000 }).toBeGreaterThan(0);
		expect(await liftOf(barcelona), 'the airport keeps the anchor point').toBe(0);
		expect(await liftOf(tallinn), 'a marker with nothing near it is left alone').toBe(0);

		const startBox = (await start.boundingBox())!;
		const airportBox = (await barcelona.boundingBox())!;
		expect(airportBox.y - (startBox.y + startBox.height)).toBeGreaterThan(0);

		// Zooming in separates the two on screen without either coordinate changing, so the
		// lift drops back to nothing and the marker returns to its own point. Paced, because
		// each press is a 300ms `easeTo` and a press landing mid-animation is dropped.
		const zoom = async (direction: 'in' | 'out', steps: number) => {
			for (let step = 0; step < steps; step++) {
				await dialog.locator(`.maplibregl-ctrl-zoom-${direction}`).click();
				await page.waitForTimeout(400);
			}
		};

		await zoom('in', 6);
		await expect.poll(() => liftOf(start), { timeout: 10_000 }).toBe(0);

		// And zooming back out brings the collision, and the stack, back.
		await zoom('out', 6);
		await expect.poll(() => liftOf(start), { timeout: 10_000 }).toBeGreaterThan(0);

		await start.click();
		await expect(start).toHaveAttribute('aria-pressed', 'true');
	});

	test('the stopover frames the city, not the runway', async ({ page }) => {
		const dialog = await openDetail(page);

		await dialog.locator('.itinerary-marker[aria-label="Stopover in Vienna"]').click();
		// The camera animation is 700ms; MapLibre rounds marker positions on `moveend`.
		await expect(dialog.locator('.map-status')).toContainText('not an address');

		await expect
			.poll(() => pixelsPerLongitudeDegree(page), { timeout: 5_000 })
			// Zoom 10 is ~1456 px per degree, zoom 13 (the old street-level framing) ~11651.
			.toBeLessThan(4_000);
	});

	test('opening a transfer says what it is showing, instead of blanking the status', async ({
		page
	}) => {
		// Issue #280 replaced the timeline row as the way to point the map at a leg: the
		// frozen preview for that leg is now the control, and it writes the same
		// `ItinerarySegmentId` the row used to. So the status line is reached through the
		// preview, and issue #141's claim is unchanged: it never goes empty, because a
		// screen reader hears an empty `role="status"` as nothing at all.
		const dialog = await openDetail(page);
		const status = dialog.locator('.map-status');

		// This itinerary prices no bed. Vienna also had no city centre — it was not one of
		// the ten airports issue #162 hand-checked — so both connection legs had no
		// destination at all, and this line read "Nothing to draw. Nothing routed into the
		// city for this stopover." VIE now has a generated centre, so the leg runs from the
		// airport to the city and there IS something to draw. Under these mocks no routing
		// provider answers, so the map draws the straight line between the two ends and says
		// that is what it is.
		await expect(status).toHaveText(/^\s*Showing Transfer to Vienna \(straight-line estimate\)\.$/);

		// The other direction, "Transfer to VIE", has no control of its own any more: a map
		// line is canvas-rendered and pointer-only, and the stopover preview opens on the
		// leg into town. `itinerary-map/status.test.ts` covers the sentence for both
		// directions without a browser, which is where that assertion belongs anyway.
		//
		// `unroutedLegNote`'s empty-leg sentences did not go away and are not dead either:
		// they are still reached for the ~1,085 airports with no centre, and whenever a
		// routing provider answers nothing for one that has one.

		// And the way back out of a selection, which did not exist before issue #141.
		await dialog.getByRole('button', { name: 'Show whole route' }).click();
		await expect(status).toHaveText('Showing the whole route.');

		await page.keyboard.press('Escape');
		await expect(page.locator('.result-detail [data-segment="transfer-to-hotel"]')).not.toHaveAttribute(
			'aria-current',
			'true'
		);
	});

	/**
	 * Issue #141's third claim was that editing a waiting time leaves the camera alone. The
	 * defect underneath it is that the focus effect must run when the *selection* changes
	 * and not on every re-render of the model.
	 *
	 * Issue #280 put the map in a modal, so a timeline stepper is no longer reachable while
	 * the map is on screen and that exact interaction cannot be staged any more. The
	 * invariant survives, and so does a way to drive it, and it is a harder one: an OS
	 * colour-scheme flip runs `map.setStyle`, which wipes every source and layer and re-adds
	 * them, then re-applies the selection. If anything in that path reaches for the camera,
	 * the traveller's own view is gone. That is the same bug on a bigger trigger.
	 */
	test('the view the traveller panned to survives a colour-scheme change', async ({ page }) => {
		const dialog = await openDetail(page);
		await dialog.getByRole('button', { name: 'Show whole route' }).click();

		// Pan somewhere deliberate first, so this proves the traveller's own view survives
		// and not merely that some default view is stable.
		const canvas = dialog.locator('.maplibregl-canvas');
		const box = (await canvas.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 60, { steps: 12 });
		await page.mouse.up();
		await page.waitForTimeout(400);

		const before = await markerTransforms(page);
		expect(before.length).toBeGreaterThan(0);

		await page.emulateMedia({ colorScheme: 'light' });
		// Longer than the 700ms camera animation the old bug would have started, and long
		// enough for `style.load` to have re-added every layer.
		await page.waitForTimeout(1_500);

		expect(await markerTransforms(page)).toEqual(before);
		await expect(dialog.locator('.map-status')).toHaveText('Showing the whole route.');
	});
});
