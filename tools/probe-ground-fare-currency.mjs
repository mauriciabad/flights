/**
 * What currency the receipt's ground rows are actually printed in, against the currency
 * the traveller picked. Issue #339.
 *
 *   node tools/probe-ground-fare-currency.mjs --url 'http://127.0.0.1:4339/results/?...' --currency EUR
 *
 * The owner reported `Rides from and to hotel  £115.04-£182.84` with EUR selected. That
 * pairing is the measurement, and no unit test can make it: the currency comes out of
 * `localStorage`, the estimate comes out of a rate card keyed by the ride's country, and
 * only a real page puts the two on one line.
 *
 * Sets the currency the way the settings screen does, through
 * `flights.searchCurrency.v1`, before the app boots. Waits on `data-search-phase`
 * (issue #337) rather than on a word being missing.
 *
 * Carries probe-results.mjs's fixture-marker guard: a currency read off a mocked page is
 * worth nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const repo = new URL('..', import.meta.url).pathname;
const markers = JSON.parse(
	readFileSync(path.join(repo, 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

function flag(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : process.argv[index + 1];
}

const url = flag('url');
const currency = flag('currency', 'EUR');
if (!url) throw new Error('pass --url');
const appOrigin = new URL(url).origin;

const browser = await chromium.launch();
const context = await browser.newContext({
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

const providerBodies = [];
const bodyReads = [];
const responses = [];
page.on('response', (r) => {
	const u = r.url();
	if (u.startsWith(appOrigin) || u.startsWith('data:')) return;
	responses.push({ status: r.status(), url: u });
	if (!/^https?:/.test(u)) return;
	bodyReads.push(
		r
			.text()
			.then((body) => providerBodies.push({ url: u, body: body.slice(0, 20000) }))
			.catch(() => {})
	);
});
const errors = [];
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page
	.locator('[data-search-phase="settled"]')
	.waitFor({ state: 'attached', timeout: 180000 })
	.catch(() => console.log('!! search never reached data-search-phase="settled"'));
await Promise.race([
	Promise.allSettled(bodyReads),
	new Promise((resolve) => setTimeout(resolve, 5000).unref())
]);

const text = await page.evaluate(() => document.body.innerText);
const leaks = [];
for (const token of FIXTURE_TOKENS) {
	if (text.includes(token)) leaks.push(`rendered page -> ${token}`);
	for (const { url: u, body } of providerBodies) {
		if (body.includes(token)) leaks.push(`${new URL(u).host} -> ${token}`);
	}
}
if (leaks.length) {
	console.log('!!! MEASUREMENT INVALID, fixture markers found:');
	for (const hit of [...new Set(leaks)].slice(0, 12)) console.log('!!!  ' + hit);
	await browser.close();
	process.exit(1);
}

console.log('picked currency:', await page.evaluate(() => localStorage.getItem('flights.searchCurrency.v1')));
console.log('COUNT:', (text.match(/\d+ of \d+ itiner\w+/) || ['(none)'])[0]);

const GROUND_LABELS = [
	'Rides from and to hotel',
	'Ride to hotel',
	'Ride from hotel',
	'Ride from origin',
	'Ride to destination'
];

const rows = page.locator('ul.results-list > li');
const rowCount = await rows.count();
console.log('cards on page:', rowCount);

for (let i = 0; i < rowCount; i++) {
	const cardText = await rows.nth(i).innerText().catch(() => '');
	const lines = cardText.split('\n').map((line) => line.trim());
	const headline = lines.find((line) => /^(from )?[^\s]*\d/.test(line)) ?? '';
	console.log(`\n=== card ${i} === ${lines.slice(0, 6).join(' | ')}`);
	console.log('-- headline:', JSON.stringify(headline));
	lines.forEach((line, index) => {
		if (GROUND_LABELS.includes(line)) console.log('-- ground:', JSON.stringify(`${line} -> ${lines[index + 1] ?? ''}`));
	});
	const caveat = cardText.match(/excludes[^\n]*/);
	if (caveat) console.log('-- caveat:', JSON.stringify(caveat[0]));
}

console.log('\n--- hosts ---');
const byHost = {};
for (const r of responses) {
	const h = new URL(r.url).host;
	byHost[h] ??= {};
	byHost[h][r.status] = (byHost[h][r.status] ?? 0) + 1;
}
console.log(JSON.stringify(byHost, null, 1));
if (errors.length) console.log('--- console errors ---\n' + [...new Set(errors)].slice(0, 8).join('\n'));
await browser.close();
