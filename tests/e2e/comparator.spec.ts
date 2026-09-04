import { test, expect } from './support/fixtures';

/**
 * The comparator (issue #25): pick several itineraries, see them side by side as columns
 * that stay aligned and scroll together on one shared timeline.
 *
 * `/comparator/?demo=1` (see src/routes/comparator/+page.svelte and demo-fixtures.ts in
 * that same directory) renders three fixture itineraries with different transfer leg
 * counts and stopover lengths, purely so this suite has a real, stable page to check CSS
 * subgrid alignment against — the one thing Comparator.test.ts genuinely cannot prove,
 * since jsdom computes no real layout. Everything else (row content, totals, provenance
 * text, the "not available yet" fallback) is already covered there and is not repeated
 * here. Real selection from search results is issue #23's job; `/comparator/` without the
 * query param already shows the honest empty state, unrelated to this suite.
 */

/** The DOM contract's fixed segment order (ItineraryTimeline.svelte) for a schema with
 * neither origin nor destination location, which is what the demo fixtures use. */
const SEGMENTS = [
	'origin-waiting',
	'outbound-flight',
	'transfer-to-hotel',
	'free-time',
	'transfer-to-connection-airport',
	'connection-waiting',
	'onward-flight'
] as const;

test.describe('comparator', () => {
	test('three itineraries with different transfer-leg counts and stopover lengths still align row for row', async ({
		page
	}) => {
		await page.goto('/comparator/?demo=1');

		const columns = page.locator('.comparator-column');
		await expect(columns).toHaveCount(3);

		for (const segment of SEGMENTS) {
			const rows = page.locator(`.comparator-column [data-segment="${segment}"]`);
			await expect(rows).toHaveCount(3);
			const boxes = await rows.evaluateAll((elements) =>
				elements.map((el) => Math.round(el.getBoundingClientRect().top))
			);
			// Subgrid's whole job: the tallest column's content at this row index sets the
			// row height everywhere, so every column's top edge for the same segment lands
			// on the same line, even though the columns' own content differs (a 3-leg
			// transfer's row is taller than a 1-leg one, a 3-night stopover's free-time
			// window is worded differently than a same-day one).
			expect(boxes[1], `${segment}: column 2 vs column 1`).toBe(boxes[0]);
			expect(boxes[2], `${segment}: column 3 vs column 1`).toBe(boxes[0]);
		}
	});

	test('scrolling the grid moves every column together, including via the keyboard', async ({ page }) => {
		await page.goto('/comparator/?demo=1');
		const scroller = page.locator('.comparator-scroll');

		await scroller.focus();
		const before = await scroller.evaluate((el) => el.scrollTop);
		await page.keyboard.press('ArrowDown');
		const afterArrow = await scroller.evaluate((el) => el.scrollTop);
		expect(afterArrow, 'ArrowDown should move the shared scroll position').toBeGreaterThan(before);

		await page.keyboard.press('End');
		const afterEnd = await scroller.evaluate((el) => el.scrollTop);
		const maxScroll = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
		expect(afterEnd, 'End should reach the bottom of the one shared scrollport').toBe(maxScroll);

		// "Every column together" is a consequence of there being exactly one scrollport
		// (see Comparator.svelte's header comment): reading each column's current row
		// position after the scroll proves they moved as a unit, not independently.
		const rowTops = await page
			.locator('.comparator-column [data-segment="outbound-flight"]')
			.evaluateAll((elements) => elements.map((el) => Math.round(el.getBoundingClientRect().top)));
		expect(new Set(rowTops).size, 'all columns should still share one row position after scrolling').toBe(1);
	});

	test('at 375px, columns scroll horizontally while the page itself does not', async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 700 });
		await page.goto('/comparator/?demo=1');

		const overflow = await page.evaluate(() => ({
			viewportWidth: window.innerWidth,
			pageScrollWidth: document.documentElement.scrollWidth,
			comparatorScrollWidth: document.querySelector('.comparator-scroll')!.scrollWidth,
			comparatorClientWidth: document.querySelector('.comparator-scroll')!.clientWidth
		}));

		expect(overflow.pageScrollWidth, 'the page itself must not scroll sideways at 375px').toBe(
			overflow.viewportWidth
		);
		expect(
			overflow.comparatorScrollWidth,
			'the comparator grid must be wider than the viewport for its columns to scroll'
		).toBeGreaterThan(overflow.comparatorClientWidth);
	});

	test('with nothing selected, shows the empty state rather than an empty grid', async ({ page }) => {
		await page.goto('/comparator/');
		await expect(page.getByText('Nothing to compare yet')).toBeVisible();
		await expect(page.locator('.comparator-scroll')).toHaveCount(0);
	});
});
