/**
 * Reads the detail panel's three surfaces against each other while the trip is edited:
 * the stopover block, the two in-city transfer rows, and the totals rail.
 *
 *   node tools/probe-detail-edits.mjs '<results url>' [--wait-only] [--keep-cache]
 *
 * It expands the first card, prints those readings as opened, swaps the bed for each other
 * property the picker offers and prints them again after every swap, then pushes the
 * connection waiting time to 700 minutes and prints them once more. `--wait-only` skips
 * the swaps and does the waiting-time edit alone, which is issue #250's own repro.
 *
 * Issues #243 and #250 were both a disagreement between those surfaces rather than a wrong
 * number on any one of them, so reading them apart could not have found either. On
 * ae99015 a bed 36.3 km from Gatwick printed the 1h 7m bus ride computed for a hotel 2.8 km
 * out, and a waiting-time edit dropped the bed from the total while the block above went on
 * charging for it.
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
const keepCache = process.argv.includes('--keep-cache');
const appOrigin = new URL(url).origin;

const browser = await chromium.launch();
const context = await browser.newContext({
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
});
const page = await context.newPage();
const providerHits = new Map();
page.on('response', (r) => {
	const u = r.url();
	if (u.startsWith(appOrigin) || u.startsWith('data:')) return;
	const host = new URL(u).host;
	providerHits.set(host, (providerHits.get(host) ?? 0) + 1);
});
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
await page.waitForFunction(() => !document.body.innerText.includes('still searching'), null, { timeout: 180_000 });

const cardCount = await page.locator('.result-card').count();
console.log(`cards: ${cardCount}`);
if (cardCount === 0) {
	console.log([...providerHits].map(([h, n]) => `${h} ${n}`).join('\n'));
	await browser.close();
	process.exit(1);
}

await page.getByRole('button', { name: 'Show details' }).first().click();
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

async function reading(label) {
	const block = flat(await detail.locator('.stopover').first().innerText());
	const rowText = async (segment) => {
		const row = detail.locator(`[data-segment="${segment}"]`);
		return (await row.count()) > 0 ? flat(await row.first().innerText()) : '(row absent)';
	};
	const totals = flat(await detail.locator('.itinerary-timeline-totals').first().innerText());
	console.log(`\n----- ${label} -----`);
	console.log('BLOCK    :', block);
	console.log('TO-BED   :', await rowText('transfer-to-hotel'));
	console.log('FROM-BED :', await rowText('transfer-to-connection-airport'));
	console.log('TOTALS   :', totals);
}

async function openStayFold() {
	if ((await detail.locator('.stay-picker, .stay-notice').count()) === 0) {
		await detail.locator('[data-segment="free-time"]').first().click();
		await page.waitForTimeout(150);
	}
}

await reading('as opened');

if (process.argv.includes('--wait-only')) {
	const only = detail.locator('[data-segment="connection-waiting"] input').first();
	await only.fill('700');
	await only.dispatchEvent('input');
	await page.waitForTimeout(250);
	await reading('after pushing the connection wait to 700 minutes, bed untouched');
	console.log('\nprovider hosts touched:', [...providerHits].map(([h, n]) => `${h}×${n}`).join(', '));
	await browser.close();
	process.exit(0);
}

await openStayFold();

const openName = await detail.locator('.stay-picker .card-header, .stay-picker header').first().innerText().catch(() => '');
console.log('\nopen property:', flat(openName));
const altNames = await detail.locator('.alt-card .alt-card-name').allInnerTexts();
console.log('stay alternatives offered:', altNames.length, JSON.stringify(altNames));

for (const name of altNames) {
	await openStayFold();
	const card = detail.locator('.alt-card', { hasText: name }).first();
	if ((await card.count()) === 0) {
		console.log(`\n(no alternative card named ${name} any more)`);
		continue;
	}
	await card.click();
	await page.waitForTimeout(250);
	await reading(`after swapping to "${name}"`);
}

const waitInput = detail.locator('[data-segment="connection-waiting"] input').first();
if ((await waitInput.count()) > 0) {
	await waitInput.fill('700');
	await waitInput.dispatchEvent('input');
	await page.waitForTimeout(250);
	await reading('after pushing the connection wait to 700 minutes');
}

console.log('\nprovider hosts touched:', [...providerHits].map(([h, n]) => `${h}×${n}`).join(', '));
await browser.close();
