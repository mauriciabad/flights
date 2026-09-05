/**
 * Acceptance condition 2: "Every flight in it exists, on the airline named, on the date
 * shown." Expands the first itinerary and prints the legs the page claims, beside the
 * carrier and flight number the provider's own response carried. Lives in .audit/ rather
 * than tools/ because ten agents are editing tools/ right now.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({
	userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
})).newPage();

const bodies = [];
const reads = [];
page.on('response', (r) => {
	const u = r.url();
	if (!/skypicker|kiwi|ryanair/i.test(u)) return;
	reads.push(r.text().then((b) => bodies.push({ u, b })).catch(() => {}));
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
for (let i = 0; i < 45; i++) {
	if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break;
	await page.waitForTimeout(2000);
}
await Promise.race([Promise.allSettled(reads), new Promise((r) => setTimeout(r, 5000).unref())]);

const btn = page.getByRole('button', { name: /show details/i }).first();
if (await btn.count()) { await btn.click(); await page.waitForTimeout(1500); }
else console.log('!! no "Show details" button found');

const detail = await page.evaluate(() => {
	const el = document.querySelector('.result-detail') || document.body;
	return el.innerText;
});
console.log('--- first itinerary, expanded ---');
console.log(detail.slice(0, 2500));

// Carrier + flight number pairs, straight out of what the provider sent.
const seen = new Set();
for (const { b } of bodies) {
	for (const m of b.matchAll(/"code"\s*:\s*"(\d{1,4})"[^}]{0,400}?"code"\s*:\s*"([A-Z0-9]{2})"/g)) seen.add(`${m[2]}${m[1]}`);
	for (const m of b.matchAll(/"carrier"\s*:\s*\{[^}]*"code"\s*:\s*"([A-Z0-9]{2})"/g)) seen.add(`carrier ${m[1]}`);
	for (const m of b.matchAll(/"(?:flightNumber|flight_no)"\s*:\s*"?(\d{1,4})"?/g)) seen.add(`flightno ${m[1]}`);
}
console.log('--- what the provider bodies carried ---');
console.log('responses captured:', bodies.length, '| tokens:', [...seen].slice(0, 40).join(' '));
const kiwi = bodies.find((x) => /skypicker/.test(x.u) && x.b.includes('sector'));
if (kiwi) console.log('--- one skypicker body, first 2000 chars ---\n' + kiwi.b.slice(0, 2000));
await browser.close();
