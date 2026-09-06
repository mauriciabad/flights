/**
 * The returning-user check: a browser whose IndexedDB was filled by the CURRENT build, then
 * pointed at the new one, on one origin so the cache actually carries over. A fresh Chromium
 * cannot show this class of bug at all.
 *
 *   node returning-user-agent-acc83cf3.mjs <url> <mainDir> <mineDir> <servedDir>
 *
 * Swaps which build the one server is serving between the two loads by rewriting `servedDir`,
 * which keeps the origin (and therefore the cache) identical.
 */
import { cpSync, rmSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [url, mainDir, mineDir, servedDir] = process.argv.slice(2);
const PROBE_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function serve(dir) {
	rmSync(servedDir, { recursive: true, force: true });
	cpSync(dir, servedDir, { recursive: true });
}

// The app is a PWA. Its service worker precaches the build's assets, so a returning user on a
// new deploy is served the OLD bundle until the worker updates. That is a real behaviour and a
// separate question from this one, and leaving it in makes the page a mix of two builds. Off,
// so what is measured here is the response cache carrying over and nothing else.
const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: PROBE_USER_AGENT, serviceWorkers: 'block' });
const page = await context.newPage();

let osrm = 0;
page.on('request', (request) => {
	if (new URL(request.url()).host === 'routing.openstreetmap.de') osrm += 1;
});
page.on('pageerror', (error) => console.log('PAGE ERROR', String(error).slice(0, 300)));

const flat = (value) => value.replace(/\s*\n\s*/g, ' | ').trim();

async function openStayList(label) {
	await page.goto(url);
	await page.locator('[data-search-phase="settled"]').waitFor({ state: 'attached', timeout: 180_000 });
	await page.locator('.result-card').first().locator('.trip-strip-unfold').click();
	const detail = page.locator('.result-detail').first();
	await detail.waitFor({ timeout: 30_000 });
	if ((await detail.locator('.stay-picker, .stay-notice').count()) === 0) {
		await detail.locator('[data-segment="free-time"]').first().click();
	}
	await page.locator('.alt-card').first().waitFor({ timeout: 60_000 });
	// The adapter chains a 1100ms gap across every concurrent caller (issue #213), and the
	// search's own lookups are still draining, so two table requests can land seconds apart.
	// Six seconds was not enough and the first run of this read the placeholder as a failure.
	for (let elapsed = 0; elapsed < 45_000; elapsed += 500) {
		await page.waitForTimeout(500);
		if ((await page.locator('.alt-card .reach-time').count()) > 0) break;
	}
	console.log(`\n----- ${label} -----`);
	const rows = page.locator('.alt-card');
	for (let index = 0; index < Math.min(3, await rows.count()); index += 1) {
		console.log(`  ROW ${flat(await rows.nth(index).innerText())}`);
	}
	console.log(`  chips with a routed time: ${await page.locator('.alt-card .reach-time').count()}`);
	// Issue #118's real road, which is what a poisoned cache entry would flatten.
	const paths = await page.locator('.itinerary-map path, .route-preview path').count();
	console.log(`  OSRM requests so far: ${osrm}`);
	return paths;
}

serve(mainDir);
await page.goto(new URL(url).origin);
await page.evaluate(
	() =>
		new Promise((resolve) => {
			const request = indexedDB.deleteDatabase('flights-cache');
			request.onsuccess = request.onerror = request.onblocked = () => resolve();
		})
);
await openStayList('on the CURRENT build (fills the cache the way a returning user has it)');

serve(mineDir);
await openStayList('on THIS branch, same browser, same IndexedDB');

// And the other direction: this branch writes thin table entries, then the map wants a road.
console.log('\n----- ground-leg geometry after the list has written -----');
const detail = page.locator('.result-detail').first();
await detail.locator('[data-segment="transfer-to-hotel"]').first().click();
await page.waitForTimeout(2500);
const legRow = detail.locator('[data-segment="transfer-to-hotel"]').first();
console.log(`  TO-BED ROW ${flat(await legRow.innerText())}`);

await browser.close();
