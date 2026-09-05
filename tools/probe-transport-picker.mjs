/**
 * What the transport picker's price column actually says, per row, in a real browser.
 *
 *   node tools/probe-transport-picker.mjs 'http://127.0.0.1:4823/results/?...' [segment]
 *
 * `probe-ground-legs.mjs` reads the receipt on each card and the modes in each panel. This
 * one goes a level deeper, into the picker a traveller opens by tapping a step, because
 * that column is where every fare claim in this app is narrowest: five different answers
 * ("No fare", a quote, a rate-card range, "No fare estimate" past that range, "Price not
 * available") share one cell, and issue #249 made them come from one function. A unit test
 * mounts that component with a hand-built transfer; this is the same column with a real
 * OSRM route behind it.
 *
 * `segment` defaults to `transfer-to-hotel` and takes any `data-segment` value from
 * `ItineraryTimeline`, e.g. `transfer-to-connection-airport`.
 *
 * Own Chromium, closed at the end, with `probe-results.mjs`'s fixture-marker guard: a price
 * read off a mocked page is worth nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(
	readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const url = process.argv[2];
const segmentId = process.argv[3] ?? 'transfer-to-hotel';
if (!url) {
	console.error('usage: node tools/probe-transport-picker.mjs <results url> [data-segment]');
	process.exit(2);
}

const browser = await chromium.launch();
const page = await (
	await browser.newContext({
		// The same UA probe-results.mjs uses, and for the same reason: Kiwi's public endpoint
		// answers "HeadlessChrome" with a 403 carrying no CORS headers.
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
	})
).newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page
	.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 60000 })
	.catch(() => {});
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
	const text = await page.evaluate(() => document.body.innerText);
	if (!/still searching/.test(text)) break;
	await page.waitForTimeout(2000);
}

const pageText = await page.evaluate(() => document.body.innerText);
const leaked = FIXTURE_TOKENS.filter((token) => pageText.includes(token));
if (leaked.length) {
	console.log('!!! MEASUREMENT INVALID, fixture markers found:', leaked.join(', '));
	await browser.close();
	process.exit(1);
}

console.log('COUNT:', (pageText.match(/\d+ of \d+ itiner\w+/) || ['(none)'])[0]);

const cards = page.locator('ul.results-list > li');
const cardCount = await cards.count();
for (let i = 0; i < cardCount; i++) {
	const card = cards.nth(i);
	const toggle = card.locator('button.details-toggle');
	if ((await toggle.count()) === 0) continue;
	await toggle.first().click();
	await page.waitForTimeout(3000);

	const stub = card.locator(`[data-segment="${segmentId}"]`).first();
	if ((await stub.count()) === 0) {
		console.log(`\n=== card ${i}: no ${segmentId} segment`);
		continue;
	}
	await stub.click();
	await page.waitForTimeout(2000);

	const rows = card.locator('.picker-row');
	const rowCount = await rows.count();
	console.log(`\n=== card ${i}, ${segmentId}: ${rowCount} rows`);
	for (let r = 0; r < rowCount; r++) {
		const cell = async (selector) =>
			(await rows.nth(r).locator(selector).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
		console.log(
			`  ${(await cell('.row-mode-label')).padEnd(18)} ${(await cell('.row-duration')).padEnd(30)} ${await cell('.row-price')}`
		);
	}
	await toggle.first().click();
}

await browser.close();
