import { expect, test, type Page } from './support/fixtures';

/**
 * The date calendar from #277, which replaced four date boxes with two painted intervals.
 *
 * Half of these assert geometry, not semantics, and that is deliberate. #268's trip-strip
 * segments shipped invisible at 0 to 2px wide with five e2e tests passing over them, because
 * every one of those tests asked whether the right elements existed and answered the right
 * words. All true of elements that had collapsed to nothing. A calendar is a grid and can
 * fail in exactly that way, so these check that cells have size, that the seven columns are
 * equal, and that an interval is drawn as one unbroken run.
 *
 * No provider is mocked and none is called: nothing here leaves the search screen.
 */

/** Every day button in the first month, with its box and where its two rails sit inside it.
 * Read from the page rather than inferred, because the inference is the thing under test. */
async function readMonth(page: Page) {
	return page.evaluate(() => {
		const month = document.querySelector('.month');
		if (!month) throw new Error('no month rendered');
		const days = [...month.querySelectorAll<HTMLElement>('button[data-date]')].map((el) => {
			const box = el.getBoundingClientRect();
			const rail = (selector: string) => {
				const node = el.querySelector(selector);
				if (!node || getComputedStyle(node).display === 'none') return null;
				const r = node.getBoundingClientRect();
				return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
			};
			return {
				date: el.dataset.date as string,
				top: box.top,
				width: box.width,
				height: box.height,
				depart: rail('.rail-depart'),
				arrive: rail('.rail-arrive')
			};
		});
		const columns = [...month.querySelectorAll<HTMLElement>('thead th')].map(
			(el) => el.getBoundingClientRect().width
		);
		return { days, columns };
	});
}

test.describe('the date calendar', () => {
	test('draws day cells with real size and seven equal columns', async ({ page }) => {
		await page.goto('/');
		const { days, columns } = await readMonth(page);

		expect(days.length).toBeGreaterThan(20);
		for (const day of days) {
			expect(day.width, `${day.date} is ${day.width}px wide`).toBeGreaterThan(20);
			expect(day.height, `${day.date} is ${day.height}px tall`).toBeGreaterThan(20);
		}

		// Without `table-layout: fixed` the column holding "31" is wider than the one holding
		// "1", the rails come out ragged, and an interval stops reading as a line.
		const spread = Math.max(...columns) - Math.min(...columns);
		expect(spread, `columns: ${columns.join(', ')}`).toBeLessThanOrEqual(1);
	});

	test('paints a travel window as one unbroken run, not a row of separate days', async ({
		page
	}) => {
		await page.goto('/');
		const start = (await readMonth(page)).days.filter((d) => d.depart === null)[2];
		await page.locator(`[data-date="${start.date}"]`).click();

		const { days } = await readMonth(page);
		const from = days.findIndex((d) => d.date === start.date);
		const end = days[from + 9];
		await page.locator(`[data-date="${end.date}"]`).click();

		const painted = (await readMonth(page)).days.filter(
			(d) => d.date >= start.date && d.date <= end.date
		);
		expect(painted).toHaveLength(10);

		for (const day of painted) {
			expect(day.depart, `${day.date} has no departure rail`).not.toBeNull();
			expect(day.depart!.width, `${day.date} rail is ${day.depart!.width}px`).toBeGreaterThan(4);
		}

		// Adjacent days on the same week row must have touching rails. A gap here is a window
		// rendered as a set of selected days, which is the interface this replaced.
		const rows = new Map<number, typeof painted>();
		for (const day of painted) {
			const row = rows.get(Math.round(day.top)) ?? [];
			row.push(day);
			rows.set(Math.round(day.top), row);
		}
		for (const row of rows.values()) {
			for (let i = 1; i < row.length; i++) {
				const gap = Math.abs(row[i].depart!.left - row[i - 1].depart!.right);
				expect(gap, `${row[i - 1].date} to ${row[i].date} breaks by ${gap}px`).toBeLessThanOrEqual(
					1
				);
			}
		}
	});

	test('shows the two windows as two rails once they stop being the same range', async ({
		page
	}) => {
		await page.goto('/');
		const all = (await readMonth(page)).days.filter((d) => d.depart === null);
		const [spanStart, spanEnd] = [all[2], all[13]];
		await page.locator(`[data-date="${spanStart.date}"]`).click();
		await page.locator(`[data-date="${spanEnd.date}"]`).click();

		// Both windows default to the whole span, so every day carries both rails.
		const unnarrowed = (await readMonth(page)).days.filter(
			(d) => d.date >= spanStart.date && d.date <= spanEnd.date
		);
		expect(unnarrowed.every((d) => d.depart && d.arrive)).toBe(true);

		await page.getByRole('button', { name: /^Leave by/ }).click();
		await page.locator(`[data-date="${all[4].date}"]`).click();
		await page.getByRole('button', { name: /^Arrive from/ }).click();
		await page.locator(`[data-date="${all[11].date}"]`).click();

		const byDate = new Map((await readMonth(page)).days.map((d) => [d.date, d]));
		const leaving = byDate.get(all[3].date)!;
		const arriving = byDate.get(all[12].date)!;
		const away = byDate.get(all[7].date)!;

		expect(leaving.depart, 'a day you could leave on has a departure rail').not.toBeNull();
		expect(leaving.arrive, 'and no arrival rail').toBeNull();
		expect(arriving.arrive, 'a day you could arrive on has an arrival rail').not.toBeNull();
		expect(arriving.depart, 'and no departure rail').toBeNull();
		expect(away.depart, 'a day between the two windows has neither').toBeNull();
		expect(away.arrive).toBeNull();

		// Two intervals the eye can separate, not two rails on top of each other.
		const apart = arriving.arrive!.top - arriving.top - (leaving.depart!.top - leaving.top);
		expect(apart, `the rails are ${apart}px apart inside the cell`).toBeGreaterThan(8);
	});

	test('keeps the typed inputs and the calendar saying the same thing', async ({ page }) => {
		await page.goto('/');
		const all = (await readMonth(page)).days.filter((d) => d.depart === null);
		await page.locator(`[data-date="${all[2].date}"]`).click();
		await page.locator(`[data-date="${all[9].date}"]`).click();

		await expect(page.locator('#soonest-departure')).toHaveValue(all[2].date);
		await expect(page.locator('#latest-arrival')).toHaveValue(all[9].date);

		// And the other way: typing is still a way in, which is why the boxes are still here.
		await page.locator('#latest-arrival').fill(all[14].date);
		const painted = (await readMonth(page)).days.filter((d) => d.depart !== null);
		expect(painted.at(-1)!.date).toBe(all[14].date);
	});

	test('is operable from the keyboard alone', async ({ page }) => {
		await page.goto('/');
		const all = (await readMonth(page)).days.filter((d) => d.depart === null);
		const anchor = all[3];

		await page.locator(`[data-date="${anchor.date}"]`).focus();
		await page.keyboard.press('Enter');
		// One row down and one day right is eight days on.
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('Enter');

		const expectedEnd = all[3 + 8].date;
		await expect(page.locator('#soonest-departure')).toHaveValue(anchor.date);
		await expect(page.locator('#latest-arrival')).toHaveValue(expectedEnd);
	});

	test('nothing on the form is behind a disclosure', async ({ page }) => {
		await page.goto('/');
		// The two `<details>` that hid the start and end points and the two narrowing dates
		// are what the owner objected to: "i also dont like that fields are collapsed".
		await expect(page.locator('form.search-form details')).toHaveCount(0);

		for (const id of [
			'origin-airport',
			'destination-airport',
			'soonest-departure',
			'latest-departure-override',
			'soonest-arrival-override',
			'latest-arrival',
			'travellers',
			'females',
			'min-layover',
			'allowed-connection-airports',
			'forbidden-connection-airports',
			'forbidden-connection-countries',
			'airlines-to-avoid'
		]) {
			await expect(page.locator(`#${id}`), `#${id} is not visible`).toBeVisible();
		}
	});
});

test.describe('the date calendar on a phone', () => {
	test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

	test('fits 375px with day cells big enough to hit', async ({ page }) => {
		await page.goto('/');
		const { days, columns } = await readMonth(page);

		for (const day of days) {
			expect(day.width, `${day.date} is ${day.width}px wide`).toBeGreaterThanOrEqual(38);
			expect(day.height, `${day.date} is ${day.height}px tall`).toBeGreaterThanOrEqual(40);
		}
		expect(Math.max(...columns) - Math.min(...columns)).toBeLessThanOrEqual(1);

		const sideways = await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth
		);
		expect(sideways, 'the page scrolls sideways at 375').toBe(false);
	});
});
