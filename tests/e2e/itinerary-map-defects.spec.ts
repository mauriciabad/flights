import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';

/**
 * Issue #141: three map defects, each with an assertion that fails on the code before the
 * fix rather than a screenshot that looks about right.
 *
 * The itinerary this builds has no stay priced, because that is the condition all three
 * defects need: with no bed, the stopover point falls back to the connection airport's own
 * coordinates and the two connection-side transfer legs never exist. BCN -> VIE -> TLL on
 * keyless Ryanair, with the fixture-marker figures every mock in this suite uses, so an
 * escaped payload reads as nonsense rather than as a working search.
 *
 * The three claims:
 *
 * 1. The stopover marker takes a real click. `locator.click()` with no `force` is the
 *    assertion: Playwright refuses to click an element another element covers, which is
 *    exactly how the issue was found ("subtree intercepts pointer events", 60 retries).
 * 2. Selecting a transfer row with nothing to draw says so. The map's `role="status"`
 *    line used to go empty, which a screen reader hears as nothing at all.
 * 3. The waiting-time stepper leaves the camera alone. Measured off MapLibre's own
 *    marker transforms, which move if and only if the camera does.
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

async function openDetail(page: Page) {
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

	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
	await page.getByRole('button', { name: 'Show details' }).first().click();

	const detail = page.locator('.result-detail');
	await expect(detail.getByRole('region', { name: /Route map/ })).toBeVisible();
	// The stopover marker only exists once the connection airport has resolved out of the
	// dataset and the model has been drawn.
	await expect(detail.locator('.itinerary-marker[aria-label="Stopover in Vienna"]')).toBeVisible();
	return detail;
}

test.describe('itinerary map defects (issue #141)', () => {
	test('the stopover marker takes a click even though it shares a coordinate with the airport', async ({
		page
	}) => {
		const detail = await openDetail(page);

		const stopover = detail.locator('.itinerary-marker[aria-label="Stopover in Vienna"]');
		const airport = detail.locator('.itinerary-marker[aria-label="Vienna (VIE)"]');

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
		await expect(detail.locator('[data-segment="free-time"]')).toHaveAttribute('aria-current', 'true');
		await expect(detail.locator('.map-status')).toContainText('Showing Stopover in Vienna.');

		// The airport pill underneath is still its own control, not collateral damage.
		await airport.click();
		await expect(airport).toHaveAttribute('aria-pressed', 'true');
		await expect(stopover).toHaveAttribute('aria-pressed', 'false');
	});

	test('the stopover frames the city, not the runway', async ({ page }) => {
		const detail = await openDetail(page);

		await detail.locator('.itinerary-marker[aria-label="Stopover in Vienna"]').click();
		// The camera animation is 700ms; MapLibre rounds marker positions on `moveend`.
		await expect(detail.locator('.map-status')).toContainText('not an address');

		await expect
			.poll(() => pixelsPerLongitudeDegree(page), { timeout: 5_000 })
			// Zoom 10 is ~1456 px per degree, zoom 13 (the old street-level framing) ~11651.
			.toBeLessThan(4_000);
	});

	test('a transfer row with nothing to draw says why, instead of blanking the status', async ({
		page
	}) => {
		const detail = await openDetail(page);

		const status = detail.locator('.map-status');
		await expect(status).toHaveText(/Showing the whole route\./);

		await detail.locator('[data-segment="transfer-to-hotel"]').click();
		await expect(detail.locator('[data-segment="transfer-to-hotel"]')).toHaveAttribute('aria-current', 'true');
		// `unroutedLegNote`'s own sentence, prefixed. Vienna is not one of the eleven
		// airports issue #162 keeps a hand-checked city centre for, so nothing routed into
		// town either and there is genuinely no line to draw.
		await expect(status).toHaveText(
			'Nothing to draw. No bed priced for this stopover, and nothing routed into the city either.'
		);

		await detail.locator('[data-segment="transfer-to-connection-airport"]').click();
		await expect(status).toHaveText(
			'Nothing to draw. No bed priced for this stopover, and nothing routed back from the city either.'
		);

		// And the way back out of a selection, which did not exist before either.
		await detail.getByRole('button', { name: 'Show whole route' }).click();
		await expect(status).toHaveText('Showing the whole route.');
		await expect(detail.locator('[data-segment="transfer-to-hotel"]')).not.toHaveAttribute('aria-current', 'true');
	});

	test('changing a waiting time keeps the view the traveller panned to', async ({ page }) => {
		const detail = await openDetail(page);

		// Pan somewhere deliberate first, so this proves the traveller's own view survives
		// and not merely that some default view is stable.
		const canvas = detail.locator('.maplibregl-canvas');
		const box = (await canvas.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 60, { steps: 12 });
		await page.mouse.up();
		await page.waitForTimeout(400);

		const before = await markerTransforms(page);
		expect(before.length).toBeGreaterThan(0);

		const waitingRow = detail.locator('[data-segment="origin-waiting"]');
		const minutes = waitingRow.locator('.tl-stepper-input');
		const startingMinutes = Number(await minutes.inputValue());

		for (let press = 0; press < 4; press++) {
			await waitingRow.getByRole('button', { name: 'Increase waiting time by 15 minutes' }).click();
		}

		// The edit landed, so this is not a test that passes because nothing happened.
		await expect(minutes).toHaveValue(String(startingMinutes + 60));
		// Longer than the 700ms camera animation the old bug would have started.
		await page.waitForTimeout(1_200);

		expect(await markerTransforms(page)).toEqual(before);
		await expect(waitingRow).not.toHaveAttribute('aria-current', 'true');
		await expect(detail.locator('.map-status')).toHaveText('Showing the whole route.');
	});
});
