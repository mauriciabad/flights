import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';

/**
 * Issue #227, and specifically the half of it a unit test cannot reach.
 *
 * `segment-stub.test.ts` pins every word the panel prints. What it cannot see is whether
 * the panel ever appears: the strip's cells are size containers with `overflow: hidden`,
 * the app shell scrolls inside `.app-content` rather than the document, and the panel is
 * a `popover="auto"` in the top layer, none of which exists in jsdom.
 *
 * The issue's own constraint is what these cases are: **"Hover does not exist on a
 * phone"**, and the strip is where this app is read on a phone. So a mouse, a thumb and a
 * keyboard each get a case, and the panel has to reach the same content by all three.
 *
 * Prices and flight numbers come from `support/fixture-markers.ts`, so a fare here is
 * five figures on a flight number no airline issues.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });
const RESULTS = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';

/** BCN to TLL through Vienna, two nights, with a keyless bed so the stopover panel has a
 * property to name. The same setup `keyless-bed.spec.ts` uses, for the same reason: it is
 * the state a first-time visitor with an empty key store actually lands in. */
async function openResults(page: Page) {
	await mockAllKeylessProviders(page.context());
	await mockHostelworld(page.context(), 'hostelworld/continents-vienna.json', 'hostelworld/properties-vienna.json');
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
	await page
		.context()
		.route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

	await page.goto(RESULTS);
	await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
	const card = page.locator('.result-card').first();
	await expect(card).toBeVisible();
	return card;
}

test.describe('the segment stub (issue #227)', () => {
	test('a mouse hovering a flight opens its stub outside the clipped cell', async ({ page }) => {
		const card = await openResults(page);
		const panel = card.getByRole('tooltip');
		await expect(panel).toBeHidden();

		const flight = card.locator('.trip-strip-hit-flight').first();
		await flight.hover();
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('FLIGHT');
		await expect(panel).toContainText(FIXTURE_FLIGHT_NUMBERS[2]!);
		await expect(panel).toContainText('Fare');

		// The whole reason it is in the top layer: a panel inside a cell would be clipped to
		// the strip's own 28px row.
		const strip = card.locator('.trip-strip').first();
		const stripBox = (await strip.boundingBox())!;
		const panelBox = (await panel.boundingBox())!;
		expect(panelBox.height).toBeGreaterThan(stripBox.height);
	});

	test('moving to a neighbour swaps the panel rather than opening a second one', async ({ page }) => {
		const card = await openResults(page);
		const panel = card.getByRole('tooltip');

		await card.locator('.trip-strip-hit-flight').first().hover();
		await expect(panel).toContainText('FLIGHT');

		await card.locator('.trip-strip-hit-stopover').first().hover();
		await expect(panel).toContainText('STOPOVER');
		await expect(card.getByRole('tooltip')).toHaveCount(1);
	});

	test('the stopover stub carries the bed, which is one booking rather than one per day', async ({ page }) => {
		const card = await openResults(page);
		const panel = card.getByRole('tooltip');

		// One target across every free-time cell: the owner settled that on the issue.
		await expect(card.locator('.trip-strip-hit-stopover')).toHaveCount(1);
		expect(await card.locator('.trip-strip-cell-free').count()).toBeGreaterThan(1);

		await card.locator('.trip-strip-hit-stopover').hover();
		await expect(panel).toContainText('STOPOVER');
		await expect(panel).toContainText('nights in Vienna');
		// "Per night", not "/night": issue #279 turned the bed's rate into a labelled figure
		// rather than a sentence. Still the same guarantee this test was written for, that
		// the stub carries one nightly rate rather than a per-day line.
		await expect(panel).toContainText('Per night');
	});

	test('a keyboard reaches every segment through one tab stop, and Escape closes the panel', async ({ page }) => {
		const card = await openResults(page);
		const panel = card.getByRole('tooltip');
		const hits = card.locator('.trip-strip-hit');
		const total = await hits.count();
		expect(total).toBeGreaterThan(3);

		// Roving tabindex: exactly one of them is in the tab order, so twenty cards cost
		// twenty tab stops rather than two hundred.
		await expect(card.locator('.trip-strip-hit[tabindex="0"]')).toHaveCount(1);

		await hits.first().focus();
		await expect(panel).toBeVisible();
		const first = await panel.locator('.stub-title').innerText();

		await page.keyboard.press('ArrowRight');
		await expect(panel).toBeVisible();
		expect(await panel.locator('.stub-title').innerText()).not.toBe(first);

		await page.keyboard.press('End');
		await expect(hits.nth(total - 1)).toBeFocused();

		await page.keyboard.press('Escape');
		await expect(panel).toBeHidden();
		// Escape closes the panel and leaves the traveller on the segment they were reading.
		await expect(hits.nth(total - 1)).toBeFocused();
	});

	test('opening one card\'s panel closes another\'s', async ({ page }) => {
		await openResults(page);
		const cards = page.locator('.result-card');
		if ((await cards.count()) < 2) test.skip(true, 'this fixture produced a single itinerary');

		await cards.nth(0).locator('.trip-strip-hit-flight').first().hover();
		await expect(cards.nth(0).getByRole('tooltip')).toBeVisible();

		await cards.nth(1).locator('.trip-strip-hit-flight').first().hover();
		await expect(cards.nth(1).getByRole('tooltip')).toBeVisible();
		await expect(cards.nth(0).getByRole('tooltip')).toBeHidden();
	});
});

/**
 * The screen this app is actually read on, and the input `title=` never had.
 *
 * Issue #278 changed where a tap lands. It used to pin this popover; it now hands the
 * segment to the customise sheet, which prints the same eyebrow, title, clocks and
 * duration from the same `segment-stub.ts` model and adds the controls for that segment.
 * A phone has no hover, so a tap was the only way to glance at a segment and it still is;
 * what it opens is bigger than what it opened before.
 *
 * The popover itself is untouched for the two inputs that still use it, hover and keyboard
 * focus, and every assertion above this line is unchanged.
 */
test.describe('tapping a segment on a phone', () => {
	test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

	test('a thumb opens the segment in the sheet, and a second tap closes it', async ({ page }) => {
		const card = await openResults(page);
		const sheet = page.locator('.customise-sheet');
		const flight = card.locator('.trip-strip-hit-flight').first();

		await flight.tap();
		await expect(sheet).toBeVisible();
		await expect(sheet.getByTestId('segment-customiser')).toHaveAttribute(
			'data-segment',
			'outbound-flight'
		);

		// No popover on top of the sheet. A tap focuses the button it lands on, and opening
		// the preview on every focus would put one there; `:focus-visible` is what keeps the
		// preview on the keyboard and the pointer's hover.
		await expect(card.getByRole('tooltip')).toBeHidden();

		await flight.tap();
		await expect(sheet).toBeHidden();
	});

	test('the sheet carries the stub\'s own words, and never covers the segment it describes', async ({
		page
	}) => {
		const card = await openResults(page);
		const sheet = page.locator('.customise-sheet');
		const strip = card.locator('.card-strip');

		await card.locator('.trip-strip-hit-stopover').tap();
		await expect(sheet).toBeVisible();
		// Straight from `segmentStubFor`, which is the same call the popover makes.
		await expect(sheet).toContainText('STOPOVER');

		const sheetBox = (await sheet.boundingBox())!;
		expect(sheetBox.x).toBeGreaterThanOrEqual(0);
		expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(375);

		// Geometry, not semantics. A reader who taps a 3px transfer seam and gets a panel
		// sitting on top of it has lost the context that made the tap mean something, and a
		// panel that is merely present in the DOM proves nothing about that.
		//
		// Polled because the card scrolls the strip clear of the sheet, and that scroll is
		// smooth: the assertion is about where this comes to rest, not about the frame the
		// sheet appeared in.
		await expect
			.poll(
				async () => {
					const box = (await strip.boundingBox())!;
					return box.y + box.height;
				},
				{ message: 'the trip strip is behind the sheet, so the segment that was tapped is not on screen' }
			)
			.toBeLessThanOrEqual(sheetBox.y);
	});

	test('the sheet closes on Escape, on its close button, and on a tap outside it', async ({ page }) => {
		const card = await openResults(page);
		const sheet = page.locator('.customise-sheet');
		const flight = card.locator('.trip-strip-hit-flight').first();

		await flight.tap();
		await expect(sheet).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();

		await flight.tap();
		await expect(sheet).toBeVisible();
		await sheet.getByRole('button', { name: 'Close' }).tap();
		await expect(sheet).toBeHidden();

		await flight.tap();
		await expect(sheet).toBeVisible();
		await page.locator('.results-subhead').tap();
		await expect(sheet).toBeHidden();
	});
});

test('every strip cell has real width, not just the right colour', async ({ page }) => {
	// The cells and the hit buttons share grid row 2. The buttons are explicitly placed, and
	// CSS grid positions definite items before auto-placed ones, so cells without an explicit
	// column spilled into implicit zero-width tracks. They kept their colour, their opacity and
	// `visibility: visible` and rendered at 0-2px, which reads as an invisible strip. Every
	// existing check passed because the elements were still there.
	await openResults(page);
	const widths = await page.evaluate(() =>
		[...document.querySelectorAll('.trip-strip-track')]
			.slice(0, 1)
			.flatMap((track) =>
				[...track.querySelectorAll('.trip-strip-cell')].map((c) => c.getBoundingClientRect().width)
			)
	);
	expect(widths.length).toBeGreaterThan(0);
	for (const width of widths) expect(width).toBeGreaterThanOrEqual(3);
	expect(widths.reduce((a, b) => a + b, 0)).toBeGreaterThan(200);
});
