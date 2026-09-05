/**
 * Issue #266, the runway half: does a flight swap say that the ride into town is quoting a
 * timetable planned for a landing that no longer happens?
 *
 *   node tools/probe-runway-timetable.mjs '<results url>' [--keep-cache]
 *
 * `probe-detail-edits.mjs --wait-only` covers the other half, where a waiting-time edit
 * moves the two legs that end at a departure gate. It cannot reach this one: a waiting-time
 * edit never moves a flight arrival, so nothing it does can stale a leg that starts at a
 * runway. Only a flight swap can, which is what this presses.
 *
 * It reads `transfer-to-hotel` before and after picking a different outbound, and prints
 * the picker's own reading of the same leg, since the timeline row and the segment stub say
 * it in different words and both have been wrong on their own before.
 *
 * Its own Chromium, closed at the end, IndexedDB cleared unless told not to. It spends no
 * request of its own: a flight swap is arithmetic, and the point is that nothing is refetched.
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
const keepCache = process.argv.includes('--keep-cache');
const appOrigin = new URL(url).origin;

const browser = await chromium.launch();
const context = await browser.newContext({
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
});
const page = await context.newPage();

const requestsAfterSwap = [];
let counting = false;
page.on('request', (r) => {
	if (counting) requestsAfterSwap.push(r.url());
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
await page.waitForFunction(() => !document.body.innerText.includes('still searching'), null, { timeout: 180_000 });
await page.getByRole('button', { name: 'Show details' }).first().click();
const detail = page.locator('.result-detail').first();
await detail.waitFor({ timeout: 30_000 });

const pageText = await page.evaluate(() => document.body.innerText);
const leaked = FIXTURE_TOKENS.filter((t) => pageText.includes(t));
if (leaked.length > 0) {
	console.log('MEASUREMENT INVALID: fixture markers on the page:', leaked.join(', '));
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
	console.log('OUTBOUND :', await rowText('outbound-flight'));
	console.log('TO-BED   :', await rowText('transfer-to-hotel'));
	console.log('FROM-BED :', await rowText('transfer-to-connection-airport'));
	console.log('TO-DEST  :', await rowText('transfer-to-destination-location'));
}

await reading('as opened');

await detail.locator('[data-segment="outbound-flight"]').first().click();
await page.waitForTimeout(200);
const rows = detail.locator('[data-segment="outbound-flight"] .picker-row');
const count = await rows.count();
console.log(`\noutbound alternatives offered: ${count}`);
if (count < 2) {
	console.log('only one outbound on this route, so there is no swap to make');
	await browser.close();
	process.exit(1);
}

let picked = -1;
for (let i = 0; i < count; i += 1) {
	if ((await rows.nth(i).locator('.row-current').count()) === 0) {
		picked = i;
		break;
	}
}
if (picked === -1) throw new Error('every outbound row claims to be the current pick');

console.log('SWAPPING TO:', flat(await rows.nth(picked).innerText()));
counting = true;
await rows.nth(picked).click();
await page.waitForTimeout(2000);

await reading('after swapping the outbound flight');
// A swap is arithmetic. Anything to a provider here would mean the app went and asked a
// question it should have answered from what it already had.
console.log(`\nnetwork requests the swap made: ${requestsAfterSwap.length}`);
for (const sent of requestsAfterSwap) console.log('  sent:', sent);
await browser.close();
