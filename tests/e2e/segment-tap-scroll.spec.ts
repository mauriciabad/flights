import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { pickStripSegment } from './support/results-ui';

/**
 * Where the page is after tapping a segment, in pixels. Issue #308.
 *
 * The owner: "When i click a segment in timeline preview to open cutmize panel, it updates
 * my scroll and is anoying." Every assertion here reads `scrollTop` before and after,
 * because the defect is invisible to a test that only checks the panel opened, and that is
 * exactly the test that existed.
 *
 * The scroller is `.app-content`, not the document: since #177 the shell scrolls inside
 * that element and `window.scrollY` on this page is always zero, so a spec reading the
 * window would measure something that cannot move and pass on any behaviour at all.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

async function openResults(page: Page) {
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
			dep: 'BCN',
			arr: 'VIE',
			depDate: '2027-03-09T16:30:00',
			arrDate: '2027-03-09T18:45:00',
			price: FIXTURE_PRICES.second,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[3]
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
	// A reading taken while "still searching" is on screen is a reading of a card that has
	// not reached its real height, in a list that has not reached its real length.
	await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
	await expect(page.locator('.result-card').first()).toBeVisible();
}

const scroller = '.app-content';

function scrollTop(page: Page): Promise<number> {
	return page.locator(scroller).evaluate((element) => element.scrollTop);
}

/** Puts the first card's strip at a chosen distance from the foot of the viewport, so a
 * test can decide whether the sheet would be covering it. */
async function placeStripFromBottom(page: Page, gap: number) {
	await page.locator(scroller).evaluate(
		(element, wanted) => {
			const strip = document.querySelector('.card-strip')!;
			const box = strip.getBoundingClientRect();
			element.scrollTop += box.bottom - (window.innerHeight - wanted);
		},
		gap
	);
	await page.waitForTimeout(150);
}

test.describe('on a wide screen the panel covers nothing, so nothing moves', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('tapping a segment leaves the scroll position exactly where it was', async ({ page }) => {
		await openResults(page);
		await placeStripFromBottom(page, 200);

		const before = await scrollTop(page);
		await pickStripSegment(page, 'flight');
		await expect(page.getByTestId('segment-customiser')).toBeVisible();
		await page.waitForTimeout(400);

		expect(await scrollTop(page), 'the customise rail is a sidebar; it hides nothing').toBe(before);
	});

	test('tapping a second segment does not move it either', async ({ page }) => {
		// The owner was sweeping across the strip, so the repeat is the real gesture.
		await openResults(page);
		await placeStripFromBottom(page, 200);
		await pickStripSegment(page, 'flight');
		await expect(page.getByTestId('segment-customiser')).toBeVisible();
		await page.waitForTimeout(400);

		const before = await scrollTop(page);
		await pickStripSegment(page, 'wait', 1);
		await page.waitForTimeout(400);

		expect(await scrollTop(page)).toBe(before);
	});
});

test.describe('on a phone it moves only when the sheet would cover the strip', () => {
	test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

	test('a strip well clear of the sheet is left alone', async ({ page }) => {
		// The sheet is capped at `min(50dvh, 26rem)`, so at 812px it takes at most 406px. A
		// strip 600px off the bottom is nowhere near it, and before this fix the scroll margin
		// made this tap move the page anyway.
		await openResults(page);
		await placeStripFromBottom(page, 600);

		const before = await scrollTop(page);
		await pickStripSegment(page, 'flight');
		await expect(page.getByTestId('segment-customiser')).toBeVisible();
		await page.waitForTimeout(500);

		expect(await scrollTop(page), 'nothing was covering the strip').toBe(before);
	});

	test('a strip under the sheet is moved, by the minimum that clears it', async ({ page }) => {
		await openResults(page);
		await placeStripFromBottom(page, 40);

		const before = await scrollTop(page);
		await pickStripSegment(page, 'flight');
		const sheet = page.locator('.customise-sheet');
		await expect(sheet).toBeVisible();
		await page.waitForTimeout(600);

		const after = await scrollTop(page);
		expect(after, 'a covered strip still has to be revealed').toBeGreaterThan(before);

		// And by the minimum: the strip now clears the sheet, and its top has not been pushed
		// off the top of the scroller to get there.
		const geometry = await page.evaluate(() => {
			const strip = document.querySelector('.card-strip')!.getBoundingClientRect();
			const sheetBox = document.querySelector('.customise-sheet')!.getBoundingClientRect();
			const content = document.querySelector('.app-content')!.getBoundingClientRect();
			return { stripTop: strip.top, stripBottom: strip.bottom, sheetTop: sheetBox.top, contentTop: content.top };
		});
		expect(geometry.stripBottom).toBeLessThanOrEqual(geometry.sheetTop + 1);
		expect(geometry.stripTop).toBeGreaterThanOrEqual(geometry.contentTop - 1);
	});
});
