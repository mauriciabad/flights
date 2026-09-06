/**
 * What a public-transport leg says where it costs money. Issue #407.
 *
 *   node tools/probe-transit-fare.mjs --url 'http://127.0.0.1:41407/results/?...' [--twice]
 *
 * The claim cannot be made by a unit test, and not for the usual reason. The fare card is
 * keyed by airport, the party comes out of the URL, the currency comes off the itinerary's
 * own total, and the boarding count comes from whatever Transitous answered on the day. Only
 * a real page puts all four together, and only a real page proves the estimate reached the
 * price column rather than stopping at the type.
 *
 * `--twice` answers the question a fresh browser can never answer, and it is the reason this
 * file exists rather than another flag on the taxi probe. It reads the page, then reloads it
 * in the SAME context, where Transitous now answers out of IndexedDB instead of over the
 * wire. The fare must be identical across the two readings. A fare folded into that cache
 * rather than computed after it would be right on the first reading and frozen on every one
 * after, for the life of an entry that is served at any age and never expires, so the owner,
 * who has used this app, would be the last person to see the fix.
 *
 * Its own Chromium, closed at the end. IndexedDB cleared before the first reading unless
 * `--keep-cache` is passed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(
	readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

function flag(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : process.argv[index + 1];
}

const url = flag('url');
if (!url) throw new Error('pass --url');
const keepCache = process.argv.includes('--keep-cache');
const twice = process.argv.includes('--twice');
const segmentId = flag('segment', 'transfer-to-origin-airport');

const clean = (value) => value.replace(/\s+/g, ' ').trim();

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();

const transitCalls = [];
page.on('response', (response) => {
	if (/transitous|motis/i.test(response.url())) transitCalls.push(response.status());
});
const errors = [];
page.on('console', (message) => {
	if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

function settle() {
	return page
		.locator('[data-search-phase="settled"]')
		.waitFor({ state: 'attached', timeout: 240000 })
		.catch(() => console.log('!! search never reached data-search-phase="settled"'));
}

async function report() {
	const pageText = await page.evaluate(() => document.body.innerText);
	const leaked = FIXTURE_TOKENS.filter((token) => pageText.includes(token));
	if (leaked.length) {
		console.log('!!! MEASUREMENT INVALID, fixture markers found:', leaked.join(', '));
		await browser.close();
		process.exit(1);
	}

	console.log('transitous responses:', transitCalls.length ? transitCalls.join(', ') : '(none over the wire)');
	console.log('COUNT:', (pageText.match(/\d+ of \d+ itiner\w+/) || ['(none)'])[0]);

	const cards = page.locator('ul.results-list > li');
	const cardCount = await cards.count();
	console.log('cards:', cardCount);

	for (let i = 0; i < Math.min(cardCount, 2); i++) {
		const card = cards.nth(i);
		const lines = (await card.innerText().catch(() => '')).split('\n').map((line) => line.trim());
		console.log(`\n=== card ${i} === ${lines.slice(0, 4).join(' | ')}`);
		const total = lines.findIndex((line) => line === 'Total price');
		if (total !== -1) console.log('  total:', lines.slice(total, total + 3).join(' / '));
		for (const [index, line] of lines.entries()) {
			if (/^Ride (from origin|to destination|to hotel|from hotel)$/.test(line)) {
				console.log('  receipt:', `${line} -> ${lines[index + 1] ?? ''}`);
			}
		}

		const toggle = card.locator('button.trip-strip-unfold');
		if ((await toggle.count()) === 0) {
			console.log('  (no trip strip to unfold)');
			continue;
		}
		await toggle.first().click();
		await page.waitForTimeout(3000);

		const stub = card.locator(`[data-segment="${segmentId}"]`).first();
		if ((await stub.count()) === 0) {
			console.log(`  (no ${segmentId} segment on this card)`);
			await toggle.first().click();
			continue;
		}
		await stub.click();
		await page.waitForTimeout(2500);

		const rows = page.locator('.picker-row');
		const rowCount = await rows.count();
		console.log(`  picker ${segmentId}: ${rowCount} rows`);
		for (let r = 0; r < rowCount; r++) {
			const cell = async (selector) =>
				clean(await rows.nth(r).locator(selector).innerText().catch(() => ''));
			console.log(
				`    ${(await cell('.row-mode-label')).padEnd(18)} ${(await cell('.row-duration')).padEnd(26)} ${await cell('.row-price')}`
			);
		}

		const citations = page.locator('.fare-citation');
		for (let c = 0; c < (await citations.count()); c++) {
			await citations
				.nth(c)
				.locator('summary')
				.click()
				.catch(() => {});
			await page.waitForTimeout(200);
			console.log('    disclosure:', clean(await citations.nth(c).innerText()).slice(0, 500));
		}
		await toggle.first().click();
	}
}

await page.goto(new URL('/', url).toString(), { waitUntil: 'domcontentloaded' });
if (!keepCache) {
	// `localStorage.clear()` does not reset this app: the response cache is IndexedDB.
	await page.evaluate(
		() =>
			new Promise((resolve) => {
				const request = indexedDB.deleteDatabase('flights-cache');
				request.onsuccess = request.onerror = request.onblocked = () => resolve();
			})
	);
}

console.log('cache:', keepCache ? 'kept' : 'cleared before the first reading');
console.log('people:', new URL(url).searchParams.get('people') ?? '(unset)');

await page.goto(url, { waitUntil: 'domcontentloaded' });
await settle();

if (twice) {
	console.log('\n--- reading 1, cold cache ---');
	await report();
	transitCalls.length = 0;
	await page.reload({ waitUntil: 'domcontentloaded' });
	await settle();
	console.log('\n--- reading 2, same context, Transitous answering from IndexedDB ---');
}

await report();

if (errors.length) console.log('\n--- console errors ---\n' + [...new Set(errors)].slice(0, 8).join('\n'));
await browser.close();
