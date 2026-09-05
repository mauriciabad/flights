/**
 * Looks at the redesigned search form (#277) in its own Chromium and measures the calendar
 * rather than trusting that it rendered.
 *
 *   node tools/probe-search-form.mjs http://127.0.0.1:4477
 *
 * The measuring is the point. #268's trip-strip segments were invisible on production at 0
 * to 2px wide while five e2e tests passed, because every one of them asserted semantics: the
 * panel opens, the keyboard reaches the segment, the right words appear. All true of an
 * element that had collapsed to nothing. A calendar is a grid, so it can fail exactly that
 * way, and this prints widths, heights and rail geometry so a claim about it can be checked.
 *
 * Its own browser, never the shared MCP one, and it closes when it is done.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4477';
const outDir = process.argv[3] ?? 'docs/screenshots';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const problems = [];
const note = (ok, message) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
	if (!ok) problems.push(message);
};

async function openForm(width, height, colorScheme, touch) {
	// `hasTouch` is what makes Chromium answer `pointer: coarse`, which is the branch a real
	// phone takes and the one that keeps 44px targets. Measuring a 375px viewport WITHOUT it
	// measures the mouse layout at a phone width, which is nobody's device.
	const context = await browser.newContext({
		viewport: { width, height },
		colorScheme,
		hasTouch: touch,
		isMobile: touch,
		deviceScaleFactor: 2
	});
	const page = await context.newPage();
	const consoleErrors = [];
	page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
	page.on('pageerror', (e) => consoleErrors.push(String(e)));
	await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
	await page.waitForSelector('.month');
	return { context, page, consoleErrors };
}

/** Every day button's box, plus where its two rails sit inside it. */
async function readCalendar(page) {
	return page.evaluate(() => {
		const month = document.querySelector('.month');
		const days = [...month.querySelectorAll('button[data-date]')].map((el) => {
			const box = el.getBoundingClientRect();
			const rail = (selector) => {
				const r = el.querySelector(selector);
				if (!r || getComputedStyle(r).display === 'none') return null;
				const b = r.getBoundingClientRect();
				return { left: b.left, right: b.right, top: b.top, width: b.width, height: b.height };
			};
			return {
				date: el.dataset.date,
				x: box.x,
				y: box.y,
				width: box.width,
				height: box.height,
				depart: rail('.rail-depart'),
				arrive: rail('.rail-arrive')
			};
		});
		const headerCells = [...month.querySelectorAll('thead th')].map(
			(el) => el.getBoundingClientRect().width
		);
		return { days, headerCells };
	});
}

async function run(width, height, colorScheme, tag, touch = false) {
	const { context, page, consoleErrors } = await openForm(width, height, colorScheme, touch);
	console.log(`\n--- ${tag} (${width}x${height}, ${colorScheme}${touch ? ', touch' : ''}) ---`);

	// What the owner sees before touching anything, captured before the probe clicks a day
	// and the browser scrolls that button into view.
	await page.screenshot({ path: `${outDir}/277-search-form-${tag}-untouched.png` });

	const before = await readCalendar(page);

	// Geometry, before anything is picked. A cell that is not a real box cannot draw a rail
	// however correct the DOM around it looks.
	const smallest = before.days.reduce((min, d) => Math.min(min, d.width, d.height), Infinity);
	note(smallest >= 20, `smallest day cell side is ${smallest.toFixed(1)}px (want >= 20)`);

	const columnWidths = before.headerCells;
	const spread = Math.max(...columnWidths) - Math.min(...columnWidths);
	note(spread <= 1, `the 7 columns differ by ${spread.toFixed(2)}px (want <= 1)`);

	// Paint a travel window, then narrow both ends, which is the state the whole design is
	// about: two intervals that overlap in the middle.
	const days = before.days;
	const start = days[3];
	const end = days[16];
	await page.locator(`[data-date="${start.date}"]`).click();
	await page.locator(`[data-date="${end.date}"]`).click();

	const spanned = await readCalendar(page);
	const inSpan = spanned.days.filter((d) => d.date >= start.date && d.date <= end.date);
	note(
		inSpan.every((d) => d.depart && d.depart.width > 0),
		`all ${inSpan.length} days of the travel window carry a departure rail with real width`
	);
	note(
		inSpan.every((d) => d.arrive && d.arrive.width > 0),
		'every day of an unnarrowed window carries an arrival rail too, since both default to the whole span'
	);

	// Contiguous: within a week row, one day's rail has to reach the next day's rail.
	const sameRow = inSpan.filter((d) => Math.abs(d.y - inSpan[1].y) < 1);
	let worstGap = 0;
	for (let i = 1; i < sameRow.length; i++) {
		worstGap = Math.max(worstGap, Math.abs(sameRow[i].depart.left - sameRow[i - 1].depart.right));
	}
	note(worstGap <= 1, `worst break between adjacent rails on one row is ${worstGap.toFixed(2)}px`);

	// Now narrow, so the two windows stop being the same interval.
	await page.getByRole('button', { name: /^Leave by/ }).click();
	await page.locator(`[data-date="${days[5].date}"]`).click();
	await page.getByRole('button', { name: /^Arrive from/ }).click();
	await page.locator(`[data-date="${days[14].date}"]`).click();

	const narrowed = await readCalendar(page);
	const byDate = new Map(narrowed.days.map((d) => [d.date, d]));
	const departOnly = byDate.get(days[4].date);
	const arriveOnly = byDate.get(days[15].date);
	const between = byDate.get(days[10].date);

	note(
		Boolean(departOnly?.depart) && !departOnly?.arrive,
		'a day inside the narrowed departure window draws the top rail only'
	);
	note(
		Boolean(arriveOnly?.arrive) && !arriveOnly?.depart,
		'a day inside the narrowed arrival window draws the bottom rail only'
	);
	note(
		!between?.depart && !between?.arrive,
		'a day between the two windows draws neither rail'
	);

	// The two rails must be in different halves of the cell, or "two intervals" is a claim
	// the pixels do not support.
	const overlapDay = byDate.get(days[7].date);
	if (departOnly?.depart && arriveOnly?.arrive) {
		const departOffset = departOnly.depart.top - departOnly.y;
		const arriveOffset = arriveOnly.arrive.top - arriveOnly.y;
		note(
			arriveOffset - departOffset > 8,
			`the two rails sit ${(arriveOffset - departOffset).toFixed(1)}px apart in the cell (want > 8)`
		);
	}
	void overlapDay;

	const typed = await page.locator('#soonest-departure').inputValue();
	note(typed === start.date, `the typed input followed the calendar: ${typed} vs ${start.date}`);

	// The page never scrolls; `.app-content` does (#177), and it is bounded by 100dvh. So a
	// fullPage shot is one viewport plus dead space and an element shot is clipped by the
	// scroller. Growing the viewport is the only capture that shows the whole form.
	await page.screenshot({ path: `${outDir}/277-search-form-${tag}-firstscreen.png` });

	// How much of the form the owner gets without scrolling, which is the thing he asked for.
	const reach = await page.evaluate(() => {
		const content = document.querySelector('.app-content');
		return { visible: content.clientHeight, total: content.scrollHeight };
	});

	await page.setViewportSize({ width, height: Math.min(reach.total + 120, 4000) });
	await page.waitForTimeout(200);
	await page.locator('.page').screenshot({ path: `${outDir}/277-search-form-${tag}.png` });
	await page.setViewportSize({ width, height });
	console.log(
		`     form needs ${reach.total}px, ${reach.visible}px visible (${((reach.visible / reach.total) * 100).toFixed(0)}% on the first screen)`
	);

	const overflows = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth
	);
	note(!overflows, 'the page does not scroll sideways');

	note(consoleErrors.length === 0, `console clean (${consoleErrors.length} errors)`);
	if (consoleErrors.length) console.log(consoleErrors.slice(0, 5).join('\n'));

	await context.close();
}

await run(375, 812, 'dark', 'dark-375', true);
await run(375, 812, 'light', 'light-375', true);
await run(1280, 900, 'dark', 'dark-1280');
await run(1280, 900, 'light', 'light-1280');

/**
 * The same form in its other home: the editor above the results, which is a narrower box
 * than the search screen and therefore a different branch of every container query.
 *
 * The search is deliberately impossible (BCN to BCN), because that is the one results URL
 * that reaches the page without asking a provider anything. Nothing here costs a request.
 */
async function runResultsEditor(width, height, colorScheme, tag) {
	const context = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 2 });
	const page = await context.newPage();
	await page.goto(`${origin}/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=BCN`, {
		waitUntil: 'networkidle'
	});
	console.log(`\n--- results editor ${tag} ---`);

	// A blocking-invalid search opens the form by itself, on the fields that need changing,
	// so there is no "Edit search" to press here.
	await page.waitForSelector('.month');

	const cells = await page.evaluate(() => {
		const month = document.querySelector('.month');
		return [...month.querySelectorAll('button[data-date]')].map((el) => {
			const b = el.getBoundingClientRect();
			return { w: b.width, h: b.height };
		});
	});
	const smallest = cells.reduce((min, c) => Math.min(min, c.w, c.h), Infinity);
	note(smallest >= 20, `results editor day cell smallest side is ${smallest.toFixed(1)}px`);

	const sideways = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth
	);
	note(!sideways, 'the results page does not scroll sideways with the editor open');

	await page.screenshot({ path: `${outDir}/277-results-editor-${tag}.png` });
	await context.close();
}

await runResultsEditor(1280, 900, 'dark', 'dark-1280');
await runResultsEditor(375, 812, 'dark', 'dark-375');

await browser.close();

console.log(`\n${problems.length === 0 ? 'ALL CHECKS PASSED' : `${problems.length} PROBLEMS`}`);
process.exit(problems.length === 0 ? 0 : 1);
