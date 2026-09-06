/**
 * Issue #267: does picking a bed the search never routed to eventually show a journey to it?
 *
 *   node tools/probe-stay-routing.mjs '<results url>' "<property name>" [--keep-cache]
 *
 * `probe-detail-edits.mjs` cannot answer this and is not wrong to be unable to. It swaps
 * every property in the picker back to back with a 250ms pause, and #267's routing is
 * deliberately superseded by the next pick, so every reading it takes is of a bed whose
 * route was abandoned a quarter of a second later. Reading that as "the feature does not
 * work" would be reading the probe's own pacing.
 *
 * So this makes ONE swap and waits. It also counts routing.openstreetmap.de requests either
 * side of the swap, which is the number the cost argument in the PR rests on: with #262's
 * 1100ms queue, what a bed costs and how long the traveller waits for it are the same
 * question asked twice.
 *
 * Its own Chromium, closed at the end, IndexedDB cleared unless told not to.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8'));
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const url = process.argv[2];
const wanted = process.argv[3];
if (!url || !wanted) throw new Error("pass a results URL and a property name");
const keepCache = process.argv.includes('--keep-cache');
const appOrigin = new URL(url).origin;

const browser = await chromium.launch();
const context = await browser.newContext({
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
});
const page = await context.newPage();

let osrmRequests = 0;
page.on('request', (r) => {
	if (new URL(r.url()).host === 'routing.openstreetmap.de') osrmRequests += 1;
});
page.on('pageerror', (e) => console.log('PAGE ERROR', String(e).slice(0, 400)));
page.on('console', (m) => {
	if (m.type() === 'error') console.log('CONSOLE ERROR', m.text().slice(0, 400));
});

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
// Issue #278 removed the "Show details" button; the strip's own caption unfolds a card now,
// the same handle `tests/e2e/support/results-ui.ts` reaches for. Issue #388: this probe waited
// on a control that had not existed for weeks, and a probe that cannot open a card reports an
// empty card rather than a broken probe.
await page.locator('.result-card').first().locator('.trip-strip-unfold').click();
const detail = page.locator('.result-detail').first();
await detail.waitFor({ timeout: 30_000 });

const pageText = await page.evaluate(() => document.body.innerText);
const found = FIXTURE_TOKENS.filter((t) => pageText.includes(t));
if (found.length > 0) {
	console.log('MEASUREMENT INVALID: fixture markers on the page:', found.join(', '));
	await browser.close();
	process.exit(2);
}

const flat = (s) => s.replace(/\s*\n\s*/g, ' | ').trim();
const rowText = async (segment) => {
	const row = detail.locator(`[data-segment="${segment}"]`);
	return (await row.count()) > 0 ? flat(await row.first().innerText()) : '(row absent)';
};

async function reading(label) {
	console.log(`\n----- ${label} -----`);
	console.log('BLOCK    :', flat(await detail.locator('.stopover').first().innerText()));
	console.log('TO-BED   :', await rowText('transfer-to-hotel'));
	console.log('FROM-BED :', await rowText('transfer-to-connection-airport'));
	// `.itinerary-timeline-totals` was deleted from the markup and this line waited on it
	// until it timed out, so this probe reported nothing on every run rather than reporting
	// a missing total. `.metric-rail` is where the figures live now.
	const totals = detail.locator('.metric-rail').first();
	console.log('TOTALS   :', (await totals.count()) ? flat(await totals.innerText()) : '(no metric rail on this card)');
}

if ((await detail.locator('.stay-picker, .stay-notice').count()) === 0) {
	await detail.locator('[data-segment="free-time"]').first().click();
	await page.waitForTimeout(150);
}

await reading('as opened');
const beforeSwap = osrmRequests;
console.log(`\nOSRM requests for the search itself: ${beforeSwap}`);

const card = detail.locator('.alt-card', { hasText: wanted }).first();
if ((await card.count()) === 0) throw new Error(`no alternative card named ${wanted}`);
await card.click();
await page.waitForTimeout(200);
await reading(`straight after swapping to "${wanted}"`);

// Long enough for two legs through #262's 1100ms queue with the search's own tail still
// draining, and short enough that a hung fetch is still reported as one.
for (let elapsed = 0; elapsed < 40_000; elapsed += 1000) {
	await page.waitForTimeout(1000);
	const row = await rowText('transfer-to-hotel');
	if (!row.includes('Nothing routed')) {
		console.log(`\nrouted after about ${(elapsed + 1000) / 1000}s`);
		break;
	}
}

await reading(`after waiting for the route to "${wanted}"`);
console.log(`\nOSRM requests the swap itself cost: ${osrmRequests - beforeSwap}`);
console.log(`OSRM requests in total: ${osrmRequests}`);
await browser.close();
