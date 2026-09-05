/**
 * What a party of four actually reads for a taxi, and what the same trip reads for one
 * traveller. Issue #344.
 *
 *   node tools/probe-taxi-party-fare.mjs --url 'http://127.0.0.1:4344/results/?...' --people 4
 *
 * The claim under test cannot be made by a unit test. The party size comes out of the URL,
 * the rate card is keyed by the ride's country, the currency comes out of `localStorage`,
 * and only a real page puts the car's fare, the per-head share and a bus with no ticket
 * price on one screen. Run it twice, once with `--people 1`, and the difference is the
 * whole issue.
 *
 * Reads three surfaces, because they have to agree: the receipt's ground rows on the card,
 * the transport picker's price column, and the picker's own disclosure.
 *
 * Waits on `data-search-phase` (issue #337, and #338 banned the text wait), and carries
 * `probe-results.mjs`'s fixture-marker guard: a fare read off a mocked page is worth
 * nothing.
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

function flag(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : process.argv[index + 1];
}

const url = flag('url');
const currency = flag('currency', 'EUR');
const segmentId = flag('segment', 'transfer-to-origin-airport');
if (!url) throw new Error('pass --url');

const browser = await chromium.launch();
const context = await browser.newContext({
	// The same UA probe-results.mjs uses, and for the same reason: Kiwi's public endpoint
	// answers "HeadlessChrome" with a 403 carrying no CORS headers.
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
});
await context.addInitScript((code) => {
	try {
		localStorage.setItem('flights.searchCurrency.v1', code);
	} catch {
		/* a browser that refuses the write leaves the app on its default, which the run reports */
	}
}, currency);
const page = await context.newPage();

const errors = [];
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page
	.locator('[data-search-phase="settled"]')
	.waitFor({ state: 'attached', timeout: 240000 })
	.catch(() => console.log('!! search never reached data-search-phase="settled"'));

const pageText = await page.evaluate(() => document.body.innerText);
const leaked = FIXTURE_TOKENS.filter((token) => pageText.includes(token));
if (leaked.length) {
	console.log('!!! MEASUREMENT INVALID, fixture markers found:', leaked.join(', '));
	await browser.close();
	process.exit(1);
}

console.log('people:', new URL(url).searchParams.get('people') ?? '(unset)');
console.log('currency:', await page.evaluate(() => localStorage.getItem('flights.searchCurrency.v1')));
console.log('COUNT:', (pageText.match(/\d+ of \d+ itiner\w+/) || ['(none)'])[0]);

const GROUND_LABELS = [
	'Rides from and to hotel',
	'Ride to hotel',
	'Ride from hotel',
	'Ride from origin',
	'Ride to destination'
];

const clean = (value) => value.replace(/\s+/g, ' ').trim();

const cards = page.locator('ul.results-list > li');
const cardCount = await cards.count();
console.log('cards:', cardCount);

for (let i = 0; i < Math.min(cardCount, 2); i++) {
	const card = cards.nth(i);
	const cardText = await card.innerText().catch(() => '');
	const lines = cardText.split('\n').map((line) => line.trim());
	console.log(`\n=== card ${i} === ${lines.slice(0, 4).join(' | ')}`);
	lines.forEach((line, index) => {
		if (GROUND_LABELS.includes(line)) console.log('  receipt:', `${line} -> ${lines[index + 1] ?? ''}`);
	});

	// Issue #278 made the trip strip's own caption the expander, so there is no separate
	// details button to click. `probe-transport-picker.mjs` still looks for one.
	const toggle = card.locator('button.trip-strip-unfold');
	if ((await toggle.count()) === 0) continue;
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

	// The picker lives in `SegmentCustomiser`, which is the desktop rail beside the list
	// rather than a child of the card, so these read the page.
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
	for (const selector of ['.schedule-gap-headline', '.schedule-gap-alternative']) {
		const notes = page.locator(selector);
		for (let n = 0; n < (await notes.count()); n++) {
			console.log(`    ${selector}:`, clean(await notes.nth(n).innerText()));
		}
	}
	const citations = page.locator('.taxi-citation');
	for (let c = 0; c < (await citations.count()); c++) {
		const summary = citations.nth(c).locator('summary');
		await summary.click().catch(() => {});
		await page.waitForTimeout(200);
		console.log('    disclosure:', clean(await citations.nth(c).innerText()).slice(0, 420));
	}
	// The timeline's own wait note, which is the half of #344 that is about the hour.
	const notes = page.locator('.tl-note-warning');
	for (let n = 0; n < (await notes.count()); n++) {
		const text = clean(await notes.nth(n).innerText());
		if (text.startsWith('First departure')) console.log('    timeline wait:', text);
	}
	await toggle.first().click();
}

if (errors.length) console.log('\n--- console errors ---\n' + [...new Set(errors)].slice(0, 8).join('\n'));
await browser.close();
