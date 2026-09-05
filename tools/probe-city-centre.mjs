/**
 * Issue #198. Does the stopover actually go into the city now?
 *
 *   node tools/probe-city-centre.mjs '<results url>' [connection IATA]
 *
 * Opens the results page, expands the itinerary through the named connection airport and
 * prints its two connection-side transfer rows, beside the routing requests the page
 * actually made. Both halves matter and they answer different questions:
 *
 *   - The rows say what the traveller reads.
 *   - The request log says whether a destination existed at all. `search/resources.ts`
 *     only asks for these two legs when it has somewhere to send them, so "zero OSRM and
 *     zero Transitous calls" is the signature of an airport with no city centre, and it
 *     looks identical on screen to a routing provider that answered nothing.
 *
 * That distinction is the whole measurement here. `router.project-osrm.org` is a free
 * shared instance and it starts returning ERR_CONNECTION_RESET after a dozen runs in a
 * short window, so a row that says no route came back can mean the throttle rather than
 * the app. The log below is how you tell.
 *
 * Its own Chromium, closed at the end, never the shared MCP browser (AGENTS.md).
 */
import { chromium } from '@playwright/test';

const url = process.argv[2];
const connection = (process.argv[3] ?? 'LGW').toUpperCase();
if (!url) {
	console.error('usage: node tools/probe-city-centre.mjs <results url> [connection IATA]');
	process.exit(2);
}

const browser = await chromium.launch();
const page = await (
	await browser.newContext({
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
	})
).newPage();

const routing = [];
page.on('response', (r) => {
	const u = r.url();
	if (/osrm|transitous/i.test(u)) routing.push({ status: r.status(), url: u });
});
page.on('requestfailed', (r) => {
	const u = r.url();
	if (/osrm|transitous/i.test(u)) routing.push({ status: r.failure()?.errorText ?? 'FAILED', url: u });
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page
	.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 90_000 })
	.catch(() => {});
for (let i = 0; i < 60; i++) {
	if (!/still searching/i.test(await page.evaluate(() => document.body.innerText))) break;
	await page.waitForTimeout(2000);
}

const cards = page.locator('.result-card');
const total = await cards.count();
let opened = false;
for (let i = 0; i < total; i++) {
	const card = cards.nth(i);
	if (!(await card.innerText()).includes(connection)) continue;
	const button = card.getByRole('button', { name: /show details/i }).first();
	if (await button.count()) {
		await button.click();
		await page.waitForTimeout(4000);
		opened = true;
	}
	break;
}
console.log(`${total} cards on screen; ${opened ? `expanded the one through ${connection}` : `NO CARD THROUGH ${connection}`}`);

const rows = await page.evaluate(() => {
	const detail = document.querySelector('.result-detail');
	if (!detail) return null;
	return [...detail.querySelectorAll('.tl-step, .tl-row, li, tr')]
		.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
		.filter((t) => /hotel|city|stopover|transfer|bus|train|taxi|walk|drive/i.test(t))
		.filter((t, i, all) => t && all.indexOf(t) === i)
		.slice(0, 14);
});

console.log('\n--- rows mentioning the city or a transfer ---');
if (!rows) console.log('(no .result-detail on the page)');
else for (const row of rows) console.log('  ' + row.slice(0, 220));

const centreLines = await page.evaluate(() =>
	[...document.querySelectorAll('body *')]
		.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
		.filter((t) => /from centre/i.test(t) && t.length < 120)
		.filter((t, i, all) => all.indexOf(t) === i)
		.slice(0, 10)
);
console.log('\n--- stay lines measured against the city centre (issue #162) ---');
if (centreLines.length === 0) console.log('  none. No stay card could state a distance from a centre.');
else for (const line of centreLines) console.log('  ' + line);

const empty = (rows ?? []).filter((r) => /Nothing routed (into|back from) the city/i.test(r));
console.log(`\nrows still saying "Nothing routed ... the city": ${empty.length}`);

console.log(`\n--- routing requests (${routing.length}) ---`);
for (const r of routing.slice(0, 20)) console.log(`  ${r.status}  ${r.url.slice(0, 150)}`);
if (routing.length === 0) {
	console.log('  none. No destination existed, so nothing was ever asked.');
}

await browser.close();
