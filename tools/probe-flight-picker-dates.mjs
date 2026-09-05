/**
 * Reads one flight picker's rows exactly as they render, one line per row.
 *
 *   node tools/probe-flight-picker-dates.mjs '<results url>' [--leg onward] [--width 375]
 *                                            [--keep-cache]
 *
 * Issue #317: the list spans several dates and no row prints one, and rows the app has
 * already ruled out still carry a price delta. Both are claims about the rendered text of
 * a row, so this prints that text with the departure date the app holds beside it, and
 * counts how many distinct dates the list covers.
 *
 * It also reports overlapping cells, which is not decoration. Adding the date cost the
 * schedule line 52px, and in the roughly 300px rail issue #278 put this picker in, that was
 * enough for the arrival clock to run under the price delta at 375, 768 and 1280 alike. The
 * row still measured the same height and `scrollWidth` still matched `clientWidth`, so
 * nothing but a box comparison or a screenshot could see it. Run this at several widths
 * before believing a picker layout change.
 *
 * Its own Chromium, closed at the end, and it clears the IndexedDB cache unless told not
 * to. Both for the reasons AGENTS.md gives about the shared browser and about
 * `localStorage.clear()` not resetting this app.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8'));
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const url = process.argv[2];
if (!url) throw new Error('pass a results URL');
const legIndex = process.argv.indexOf('--leg');
const leg = legIndex === -1 ? 'outbound' : process.argv[legIndex + 1];
const widthIndex = process.argv.indexOf('--width');
const width = widthIndex === -1 ? 1280 : Number(process.argv[widthIndex + 1]);
const keepCache = process.argv.includes('--keep-cache');
const appOrigin = new URL(url).origin;

const browser = await chromium.launch();
const context = await browser.newContext({
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
	viewport: { width, height: 900 }
});
const page = await context.newPage();
page.on('console', (m) => {
	if (m.type() === 'error') console.log('CONSOLE ERROR', m.text().slice(0, 300));
});
page.on('pageerror', (e) => console.log('PAGE ERROR', String(e).slice(0, 300)));

await page.goto(appOrigin);
if (!keepCache) {
	await page.evaluate(
		() =>
			new Promise((r) => {
				const req = indexedDB.deleteDatabase('flights-cache');
				req.onsuccess = req.onerror = req.onblocked = () => r();
			})
	);
}

await page.goto(url);
// Issue #388. "still searching" is absent before a search starts as well as after one has
// finished, so waiting for it to go away is a wait satisfied by absence, which is #337.
// `data-search-phase` is written from a snapshot carrying `done`, so `settled` is evidence
// the search actually happened.
await page.locator('[data-search-phase="settled"]').waitFor({ state: 'attached', timeout: 180_000 });
// The search settling is not the same event as the page holding still: a refetch repaints
// in place. One quiet second before anything is read.
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(1000);
await page.locator('[data-search-phase="settled"]').waitFor({ state: 'attached', timeout: 60_000 });

const cardCount = await page.locator('.result-card').count();
console.log(`cards: ${cardCount}`);
if (cardCount === 0) {
	await browser.close();
	process.exit(1);
}

// The trip strip on the collapsed card opens the customise panel on the segment tapped,
// which is how the issue's reporter reached this list: "clicking the first flight".
const flightButtons = page.locator('.result-card').first().getByRole('button', { name: /^Flight,/ });
await flightButtons.nth(leg === 'outbound' ? 0 : 1).click();

const picker = page.locator('.flight-picker').first();
await picker.waitFor({ timeout: 30_000 });

const bodyText = await page.evaluate(() => document.body.innerText);
const leaked = FIXTURE_TOKENS.filter((token) => bodyText.includes(token));
if (leaked.length > 0) {
	console.log(`MEASUREMENT INVALID: fixture marker on the page: ${leaked.join(', ')}`);
	await browser.close();
	process.exit(2);
}

const summary = await picker.locator('.picker-provenance').first().innerText().catch(() => '(no caption)');
console.log(`caption: ${summary}`);

const rows = await picker.locator('.picker-row').evaluateAll((nodes) =>
	nodes.map((node) => ({
		text: node.innerText.replace(/\n+/g, ' | '),
		hasDelta: node.querySelector('.delta-text') !== null,
		deltaText: node.querySelector('.delta-text')?.textContent?.trim() ?? '',
		warning: node.querySelector('.row-warning')?.textContent?.trim() ?? '',
		date: node.querySelector('.row-date')?.textContent?.trim() ?? '',
		height: Math.round(node.getBoundingClientRect().height)
	}))
);

const overlaps = await picker.evaluate((node) => {
	const found = [];
	for (const row of node.querySelectorAll('.picker-row')) {
		const cells = [...row.querySelectorAll('.row-schedule, .row-meta, .row-price, .row-delta')]
			.map((cell) => ({ name: cell.className.split(' ')[0], box: cell.getBoundingClientRect() }))
			.filter((cell) => cell.box.width > 0);
		for (let i = 0; i < cells.length; i++)
			for (let j = i + 1; j < cells.length; j++) {
				const a = cells[i].box;
				const b = cells[j].box;
				if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
					found.push(`${cells[i].name} over ${cells[j].name}`);
			}
	}
	return found;
});

console.log(`viewport: ${width}px, picker: ${await picker.evaluate((el) => Math.round(el.getBoundingClientRect().width))}px`);
console.log(`rows: ${rows.length}`);
for (const row of rows) {
	console.log(`  [${row.height}px] ${row.text}`);
	console.log(`      date cell: ${row.date || '(none)'} | delta: ${row.deltaText || '(none)'} | warning: ${row.warning ? 'yes' : 'no'}`);
}

const pricedImpossible = rows.filter((row) => row.warning.includes('no connection to make') && row.hasDelta);
console.log(`rows with a "no connection" warning AND a price delta: ${pricedImpossible.length}`);
const datedRows = rows.filter((row) => /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(row.text));
console.log(`rows carrying a weekday: ${datedRows.length} of ${rows.length}`);
console.log(`picker height: ${await picker.evaluate((el) => Math.round(el.getBoundingClientRect().height))}px`);
console.log(`overlapping cells: ${overlaps.length === 0 ? 'none' : overlaps.join(', ')}`);

await browser.close();
