/**
 * What every card's ground legs actually are, next to the receipt line that summarises
 * them.
 *
 *   node tools/probe-ground-legs.mjs 'https://flights.mauri.app/results/?...'
 *
 * `probe-results.mjs` reports what the whole page says and what the network did. This one
 * opens each card's detail panel, which is the only place the mode of each ground leg is
 * written down, and prints it beside that card's "Ground, N rides" line. That pairing is
 * the measurement: a receipt line naming three unquoted rides on a trip whose panel shows
 * four ground legs is a walk the receipt left out.
 *
 * Carries `probe-results.mjs`'s fixture-marker guard, because a mode read off a mocked
 * page is worth nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const repo = new URL('..', import.meta.url).pathname;
const markers = JSON.parse(
	readFileSync(path.join(repo, 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const url = process.argv[2];
const appOrigin = new URL(url).origin;

const browser = await chromium.launch();
const page = await (
	await browser.newContext({
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
	})
).newPage();

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
	.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 })
	.catch(() => {});
const deadline = Date.now() + 120000;
let text = '';
while (Date.now() < deadline) {
	text = await page.evaluate(() => document.body.innerText);
	if (!/still searching/.test(text)) break;
	await page.waitForTimeout(2000);
}
await Promise.race([
	Promise.allSettled(bodyReads),
	new Promise((resolve) => setTimeout(resolve, 5000).unref())
]);

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

console.log('COUNT:', (text.match(/\d+ of \d+ itiner\w+/) || ['(none)'])[0]);

const rows = page.locator('ul.results-list > li');
const rowCount = await rows.count();
console.log('cards on page:', rowCount);

/** Every `Ground, ...` row on a receipt with the amount beneath it, not only the first.
 * There can be two of them (a walked row and an unquoted one) and reporting one would hide
 * exactly the pairing this tool exists to show. */
function groundRows(cardText) {
	const lines = cardText.split('\n');
	const found = [];
	lines.forEach((line, index) => {
		if (line.startsWith('Ground,')) found.push(`${line.trim()} -> ${lines[index + 1]?.trim() ?? ''}`);
	});
	return found;
}

for (let i = 0; i < rowCount; i++) {
	const row = rows.nth(i);
	const collapsed = await row.innerText().catch(() => '');
	console.log(`\n=== card ${i} === ${collapsed.split('\n').slice(0, 12).join(' ')}`);
	for (const line of groundRows(collapsed)) console.log('-- receipt:', JSON.stringify(line));
	if (groundRows(collapsed).length === 0) console.log('-- receipt: (no ground row)');

	const toggle = row.locator('button.details-toggle');
	if ((await toggle.count()) === 0) continue;
	await toggle.first().click();
	await page.waitForTimeout(3000);
	const expanded = await row.innerText().catch(() => '');
	// The caveat lives on the totals bar inside the panel, never on the collapsed card, so
	// it is only readable once this is open.
	console.log('-- total caveat:', JSON.stringify((expanded.match(/excludes[^\n]*/) || ['(none)'])[0]));
	console.log('-- expanded panel --');
	console.log(expanded);
	await toggle.first().click();
	await page.waitForTimeout(600);
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
