import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

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

	await page.goto(RESULTS);
	await waitForSearchToSettle(page, { timeout: 20_000 });
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
		// This test is about where a tap lands, not about how the page gets there. Issue #308's
		// reveal is a smooth scroll, and a tap aimed at a segment while it is still travelling
		// lands on whatever is over that spot right now. `reveal-scroll.ts` already skips the
		// travel for a reader who asked for less motion, so asking for it here makes the final
		// position the only position there is.
		await page.emulateMedia({ reducedMotion: 'reduce' });
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

		// The reveal has to have landed before the second tap. Issue #308 moves the strip up by
		// exactly enough to clear the sheet, and until that is done the cell is still
		// underneath: Playwright's own scroll-into-view then fights it, retry after retry, and
		// the failure reads as "the sheet intercepts pointer events" with nothing about timing
		// in it. Reduced motion above makes the move instant; this says what "landed" means.
		//
		// Measured on this fixture: the strip settles at 331..410 against a sheet whose top is
		// 410, so the app's arithmetic is right and the test was reading it early. Issue #435
		// surfaced it by making the card 80px taller, which turned a scroll that used to be a
		// no-op here into a real one.
		await expect
			.poll(() =>
				page.evaluate(() => {
					const strip = document.querySelector('.card-strip')?.getBoundingClientRect();
					const sheetBox = document.querySelector('.customise-sheet')?.getBoundingClientRect();
					return strip !== undefined && sheetBox !== undefined && strip.bottom <= sheetBox.top + 1;
				})
			)
			.toBe(true);

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

	test('the panel is placed on the frame it appears, not on its way to the right place', async ({ page }) => {
		// The test above is the one a traveller feels, and it only fails when the machine is
		// slow enough to lose the race. This is the same defect asserted where it cannot
		// hide, because the panel's own arithmetic decides it and nothing else does.
		//
		// `place` cannot measure the panel until `showPopover` has displayed it, so the first
		// style pass of a panel that has just opened has no `--x`/`--y` and resolves both to
		// zero. With `translate` transitionable across that pass the panel then travelled from
		// the corner of the window to the cell over 160ms, and everything under that path was
		// covered on the way. Measured at 375x812 before the fix, the panel stood at
		// 0,4..336,432 while the segment it belongs to ran 418..446.
		//
		// A phone is where that matters. Chromium hit-tests again for the `mouseup` it
		// synthesises from a tap, so a panel over the thumb takes the click, which is
		// dispatched to its common ancestor with the button and selects nothing.
		//
		// A hover rather than a tap, because a tap has a click to lose and this is about where
		// the panel is, not about what the press does. A focus is out too, since
		// `element.focus()` scrolls the button into view and the strip closes the panel on any
		// scroll, so the panel opened and shut again before it could be measured.
		const card = await openResults(page);
		const hit = card.locator('.trip-strip-hit-stopover');

		// Installed and awaited before the hover, so the listener is certainly up, and on the
		// document rather than on the panel, because the results list is still revalidating
		// and a card that re-renders takes its panel's node with it. `toggle` does not bubble;
		// a capturing listener sees it anyway. The frame after the panel opens rather than the
		// moment it comes to rest, since settling is what the broken version eventually did
		// too.
		await page.evaluate(() => {
			Object.assign(window, {
				firstFrame: new Promise<[number, number, number, number]>((resolve, reject) => {
					document.addEventListener(
						'toggle',
						(event) => {
							const panel = event.target;
							if ((event as ToggleEvent).newState !== 'open') return;
							if (!(panel instanceof HTMLElement) || !panel.classList.contains('stub')) return;
							requestAnimationFrame(() => {
								const box = panel.getBoundingClientRect();
								resolve([box.left, box.top, box.right, box.bottom]);
							});
						},
						{ capture: true }
					);
					setTimeout(() => reject(new Error('the panel never opened')), 5_000);
				})
			});
		});

		await hit.hover();
		const [left, top, right, bottom] = await page.evaluate(
			() => (window as unknown as { firstFrame: Promise<[number, number, number, number]> }).firstFrame
		);
		const cell = (await hit.boundingBox())!;
		const covered =
			left < cell.x + cell.width && right > cell.x && top < cell.y + cell.height && bottom > cell.y;
		expect(
			covered,
			`the panel was at ${left},${top}..${right},${bottom} over a segment at ${cell.x},${cell.y}..${cell.x + cell.width},${cell.y + cell.height}`
		).toBe(false);
	});

	test('a thumb that rests on a segment does not flash the preview the press suppresses', async ({
		page,
		context
	}) => {
		// Issue #456. The strip suppresses the preview for the focus a press causes, and the
		// whole question is how long that suppression lasts. `tap()` is no use here. It sends
		// `touchStart` and `touchEnd` in the same millisecond, which is not a gesture a hand
		// makes and is the one duration where every version of this passes. A thumb rests on
		// the glass for 50 to 150ms, so this presses and holds through CDP.
		//
		// 160ms because Chromium suppresses timer queues for the first 100ms after a
		// `touchstart` and no longer. That is what made a zero-delay clear a defect rather
		// than a race. Past that mark the macrotask ran mid-gesture, every time, and the
		// compatibility focus that followed it opened the panel. Measured at 375x812 before
		// the fix, a press of 80ms and every longer one did it (`tools/probe-strip-press.mjs`).
		await page.emulateMedia({ reducedMotion: 'reduce' });
		const card = await openResults(page);
		const hit = card.locator('.trip-strip-hit-flight').first();
		await hit.scrollIntoViewIfNeeded();

		// Read as each event is dispatched rather than after the gesture. The panel opens and
		// shuts again inside one press, so anything sampled afterwards sees nothing. Its own
		// `toggle` event is no better, because the HTML spec replaces a queued popover toggle
		// task, so an open and a close in one turn dispatch a single closed-to-closed event.
		await page.evaluate(() => {
			const seen: string[] = [];
			for (const type of ['mousedown', 'focusin', 'mouseup', 'click']) {
				document.addEventListener(
					type,
					() => seen.push(`${type} ${document.querySelector('.stub:popover-open') ? 'OPEN' : 'shut'}`),
					{ capture: true }
				);
			}
			Object.assign(window, { pressStates: seen });
		});

		const cell = (await hit.boundingBox())!;
		const touchPoints = [{ x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 }];
		const cdp = await context.newCDPSession(page);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
		await page.waitForTimeout(160);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

		// The press still selects the segment. Without this the test would pass just as well
		// on a strip that had stopped responding to a thumb altogether.
		await expect(page.locator('.customise-sheet')).toBeVisible();

		const states = await page.evaluate(() => (window as unknown as { pressStates: string[] }).pressStates);
		expect(states.join(', ')).not.toContain('OPEN');
	});

	test('a panel too tall for the room keeps its eyebrow on screen', async ({ page }) => {
		// Issue #457. `place` caps the counterfoil with `--stub-body-max` when neither side of
		// the strip has room for the whole panel, and then has to place the panel at the
		// height that cap produced. It measured before capping and budgeted the cap without
		// `.stub-bottom`'s own padding and borders, so the panel came out taller than the room
		// twice over and hung off the window, taking the eyebrow with it. Measured at 375x812
		// before the fix, the panel's top sat at -25 against an 8px edge.
		//
		// A short window rather than the describe block's 812, so the cap certainly engages on
		// whatever this fixture's stopover panel weighs, and the assertion below says so
		// rather than passing vacuously if it ever stops.
		const card = await openResults(page);
		await page.setViewportSize({ width: 375, height: 640 });
		const hit = card.locator('.trip-strip-hit-stopover');
		await hit.scrollIntoViewIfNeeded();

		// The app shell scrolls inside `.app-content` rather than the document, and any scroll
		// closes an open panel, so the strip is put where it is wanted before it is hovered.
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const box = (await hit.boundingBox())!;
			const delta = Math.round(box.y - 380);
			if (Math.abs(delta) <= 1) break;
			await page.evaluate((by) => {
				const scroller = document.querySelector('.app-content') ?? document.scrollingElement!;
				scroller.scrollTop += by;
			}, delta);
			await page.waitForTimeout(60);
		}

		const panel = card.getByRole('tooltip');
		await hit.hover();
		await expect(panel).toBeVisible();
		// The 4px entry rise is a `transform` over the `translate` that carries the placement,
		// so a box read while it runs is 4px from the one a reader sees.
		await expect
			.poll(() => panel.evaluate((node) => getComputedStyle(node).transform))
			.toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);

		const placement = await panel.evaluate((node) => ({
			bodyMax: node.style.getPropertyValue('--stub-body-max'),
			top: Math.round(node.getBoundingClientRect().top),
			bottom: Math.round(node.getBoundingClientRect().bottom),
			eyebrowTop: Math.round(node.querySelector('.stub-eyebrow')!.getBoundingClientRect().top),
			windowHeight: window.innerHeight
		}));
		expect(
			placement.bodyMax,
			'the counterfoil was not capped, so this window is too tall to be asking the question'
		).not.toBe('none');
		expect(placement.top, `the panel stood at ${placement.top}..${placement.bottom}`).toBeGreaterThanOrEqual(8);
		expect(placement.bottom).toBeLessThanOrEqual(placement.windowHeight - 8);
		expect(placement.eyebrowTop).toBeGreaterThanOrEqual(8);
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
		// Issue #318: "Done", not "Close". The desktop rail said "Clear" and this said
		// "Close" for the same call, and the summary bar's own collapse control on this page
		// is already the "Close" button.
		await sheet.getByRole('button', { name: 'Done' }).tap();
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
