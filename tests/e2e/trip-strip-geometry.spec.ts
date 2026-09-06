import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Where the trip strip's captions and hit targets actually are, in pixels.
 *
 * Issues #315 and #316 were both found by measuring a production page and both were
 * invisible to every existing test, for the same reason `45151ce` was: a suite can assert
 * that the right words are on screen, that a panel opens and that the keyboard reaches
 * every cell, and all of that is true of a caption printed under the wrong block and of a
 * target too narrow to hit. So everything here reads boxes.
 *
 * #315: the caption row was a three-item `space-between` flex laid under a seven-block
 * strip, so each flight's duration printed under the airport wait beside it. Measured at
 * 1280px on the Sofia card, the caption `2h 55m` spanned x 381-424, the flight it named ran
 * 448-526, and the wait it was sitting over ran 381-446. Three cards, three identical
 * misses.
 *
 * #316: at 375px a ground transfer drew 15px wide with a 2px gap to each neighbour, which
 * fails WCAG 2.2 SC 2.5.8 with no exception available.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** Every ground leg the app can draw at once: an origin location, a destination location
 * and a priced bed in between, which is what puts four transfer seams on one strip. That is
 * the case #316 measured, and the one where the 24px floors have the least room. */
const FOUR_LEG_URL =
	'/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL' +
	`&fromLoc=${encodeURIComponent('Barcelona Sants@41.3792,2.1400')}` +
	`&toLoc=${encodeURIComponent('Tallinn old town@59.4370,24.7536')}`;

async function openResults(page: Page, url = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL') {
	await mockAllKeylessProviders(page.context());
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna.json'
	);
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
	await page.goto(url);
	// The reading is worthless until the search settles: a card mid-stream is a different
	// height and a different set of segments from the one a traveller reads.
	await waitForSearchToSettle(page, { timeout: 20_000 });
	const card = page.locator('.result-card').first();
	await expect(card).toBeVisible();
	return card;
}

/**
 * Every tappable block on the first card's strip, with its box and the segment it names.
 *
 * The checks below all end in "and none of them is too small" or "too close", which an empty
 * strip satisfies as comfortably as a well-spaced one. Issue #382 is a list of five times
 * exactly that passed for the wrong reason, so the premise is stated here, once, for every
 * caller.
 */
async function stripTargets(page: Page) {
	const hits = page.locator('.result-card').first().locator('.trip-strip-hit');
	await expect(hits.first(), 'no strip blocks on screen, so a geometry sweep proves nothing').toBeVisible();
	return hits.evaluateAll((blocks) =>
		blocks.map((hit) => {
			const box = hit.getBoundingClientRect();
			return {
				label: hit.getAttribute('aria-label') ?? '',
				left: box.left,
				right: box.right,
				width: box.width,
				height: box.height,
				centre: box.left + box.width / 2
			};
		})
	);
}

test.describe('the captions name the block they sit under (#315)', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test("each flight's duration is printed over that flight and not over the wait beside it", async ({
		page
	}) => {
		const card = await openResults(page);

		const captions = await card.locator('.trip-strip-caption-leg').evaluateAll((nodes) =>
			nodes.map((node) => {
				const box = node.getBoundingClientRect();
				return { text: node.textContent?.trim() ?? '', centre: box.left + box.width / 2 };
			})
		);
		const targets = await stripTargets(page);
		const flights = targets.filter((target) => target.label.startsWith('Flight'));

		expect(captions).toHaveLength(2);
		expect(flights).toHaveLength(2);

		// The assertion the issue asks for: every caption's horizontal centre falls inside the
		// block it names. Before this fix the first caption's centre was 43px to the left of
		// its flight's left edge, entirely inside the airport-wait block.
		for (const [index, caption] of captions.entries()) {
			const flight = flights[index]!;
			expect(
				caption.centre,
				`caption "${caption.text}" starts left of the flight it names (${flight.label})`
			).toBeGreaterThanOrEqual(flight.left);
			expect(
				caption.centre,
				`caption "${caption.text}" ends right of the flight it names (${flight.label})`
			).toBeLessThanOrEqual(flight.right);
		}
	});

	test('the stopover caption spans the stretch between the two flights', async ({ page }) => {
		const card = await openResults(page);
		const targets = await stripTargets(page);
		const flights = targets.filter((target) => target.label.startsWith('Flight'));

		const caption = (await card.locator('.trip-strip-caption-mid').boundingBox())!;
		// It is the control that unfolds the timeline, so it has to be over the stopover it
		// unfolds rather than over either flight.
		expect(caption.x).toBeGreaterThanOrEqual(flights[0]!.right - 1);
		expect(caption.x + caption.width).toBeLessThanOrEqual(flights[1]!.left + 1);
	});

	test('nothing on the card still prints the scale as a label (#310)', async ({ page }) => {
		const card = await openResults(page);
		await expect(card.getByText('√ scale')).toHaveCount(0);
		// The scale itself is unchanged, and the strip still says so where a screen reader
		// will hear it.
		await expect(card.getByRole('group', { name: /square-root time scale/ })).toHaveCount(1);
	});
});

test.describe('every strip block is big enough to hit (#316)', () => {
	test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

	test('no target is under 24px, on the trip with the most ground legs', async ({ page }) => {
		await openResults(page, FOUR_LEG_URL);
		const targets = await stripTargets(page);

		expect(targets.length).toBeGreaterThan(4);
		const undersized = targets.filter((target) => target.width < 24 || target.height < 24);
		expect(
			undersized.map((target) => `${target.label}: ${Math.round(target.width)}x${Math.round(target.height)}`),
			'WCAG 2.2 SC 2.5.8 wants 24x24, and a transfer seam measured 15x28 on production'
		).toEqual([]);
	});

	test('adjacent targets are at least 24px apart centre to centre', async ({ page }) => {
		// The Spacing exception is the other half of SC 2.5.8 and the half a padded 15px
		// block failed: two 24px areas centred 17px apart still overlap, and the neighbour's
		// z-index decides who wins the tap.
		await openResults(page, FOUR_LEG_URL);
		const targets = (await stripTargets(page)).sort((a, b) => a.centre - b.centre);
		// The same premise the sibling check states: this trip has more than four blocks, so
		// "no pair is too close" is a claim about real pairs.
		expect(targets.length).toBeGreaterThan(4);

		const tooClose = targets
			.slice(1)
			.map((target, index) => ({ target, previous: targets[index]! }))
			.filter(({ target, previous }) => target.centre - previous.centre < 24);

		expect(
			tooClose.map(({ target, previous }) => `${previous.label} -> ${target.label}`),
			'two blocks this close cannot both be hit'
		).toEqual([]);
	});

	test('every control on a settled results page clears 24px', async ({ page }) => {
		// The issue's own sweep, run over the whole page rather than the strip alone, since
		// its second finding was the timeline unfold control at 19px tall.
		await openResults(page, FOUR_LEG_URL);
		const { controls, small } = await page.evaluate(() => {
			const visible = [...document.querySelectorAll('a,button,input,select,[role="button"]')]
				.map((element) => ({
					name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '',
					box: element.getBoundingClientRect()
				}))
				// A control with no box at all is inside something closed, which is not a target.
				.filter(({ box }) => box.width > 0 && box.height > 0);
			return {
				controls: visible.length,
				small: visible
					.filter(({ box }) => box.width < 24 || box.height < 24)
					.map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`)
			};
		});

		// The sweep's own premise: an empty page has no control under 24px either. Issue #382.
		expect(controls, 'no visible controls on the results page').toBeGreaterThan(10);
		expect(small).toEqual([]);
	});
});
