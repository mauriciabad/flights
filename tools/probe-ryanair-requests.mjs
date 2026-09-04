/**
 * Counts what one search actually costs Ryanair, split by endpoint, on a genuinely cold
 * cache and then again warm. Issue #121's acceptance test.
 *
 * The split is the point. "97 requests" hides that 80 of them were one endpoint asked
 * once per candidate airport, and a total alone cannot tell a route-graph regression from
 * a search that simply found more candidates worth pricing. It also prints the itinerary
 * count, because the fare number moves with how many candidates the pipeline decided to
 * price (issue #115's fallback sweep), and comparing two runs that took different paths
 * through that is how you talk yourself into a win you did not get.
 *
 *   node tools/probe-ryanair-requests.mjs                      # production
 *   node tools/probe-ryanair-requests.mjs http://localhost:4173 # a local `vite preview`
 */
import { chromium } from '@playwright/test';

const base = (process.argv[2] ?? 'https://flights.mauri.app').replace(/\/$/, '');
const target = `${base}/results/?${process.argv[3] ?? 'from=BCN&to=OTP&dep=2026-10-01&arr=2026-10-25'}`;

function endpointOf(url) {
	const u = new URL(url);
	if (u.pathname.includes('/views/locate/searchWidget/routes/')) return 'route graph, one per airport';
	if (u.pathname.includes('/views/locate/3/airports')) return 'active airports (whole network)';
	if (u.host === 'services-api.ryanair.com') return 'fares';
	return `other (${u.pathname.slice(0, 40)})`;
}

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

const ryanair = [];
page.on('response', (r) => {
	if (r.url().includes('ryanair.com')) ryanair.push({ url: r.url(), status: r.status() });
});
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

async function search(label) {
	const before = ryanair.length;
	await page.goto(target, { waitUntil: 'domcontentloaded' });

	// Settle on "no new Ryanair request for 10s" rather than a fixed wait: a search that
	// spends 97 requests takes far longer than one that spends 13, and a fixed wait would
	// quietly undercount the slow one, which is the one being argued against.
	let seen = -1;
	let quietSince = Date.now();
	const deadline = Date.now() + 240_000;
	while (Date.now() < deadline) {
		await page.waitForTimeout(1000);
		if (ryanair.length !== seen) {
			seen = ryanair.length;
			quietSince = Date.now();
		} else if (Date.now() - quietSince > 10_000) break;
	}

	const slice = ryanair.slice(before);
	const counts = new Map();
	for (const { url, status } of slice) {
		const key = `${endpointOf(url)} [${status}]`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const text = await page.evaluate(() => document.body.innerText);
	console.log(`\n=== ${label}: ${slice.length} Ryanair requests ===`);
	for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
	console.log(`  found: ${(text.match(/\d+ of \d+ itiner\w+/) ?? ['(no itinerary count on the page)'])[0]}`);
	return slice.length;
}

// A fresh context already has an empty localStorage and Cache Storage, but IndexedDB is
// where this app's response cache lives, and that survives everything else (AGENTS.md).
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.evaluate(
	() =>
		new Promise((resolve) => {
			const req = indexedDB.deleteDatabase('flights-cache');
			req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined);
		})
);

const cold = await search('cold cache');
const warm = await search('same search again');
console.log(`\n### ${base}  cold=${cold}  warm=${warm}`);
await browser.close();
