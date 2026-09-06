/**
 * What one bed swap costs in OSRM requests, on a build that has the stay-list table lookup
 * and on one that does not. The question is whether making a duration-only cache entry a
 * miss for every `getCachedRoute` caller turns a two-request feature into a costly one.
 *
 *   node .audit/probe-swap-cost-agent-acc83cf3.mjs <results url>
 */
import { chromium } from '@playwright/test';
import { PROBE_USER_AGENT } from '../tools/probe-browser.mjs';

const url = process.argv[2];
const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: PROBE_USER_AGENT });
const page = await context.newPage();

let osrm = 0;
page.on('request', (request) => {
	if (new URL(request.url()).host === 'routing.openstreetmap.de') osrm += 1;
});

await page.goto(new URL(url).origin);
await page.evaluate(
	() =>
		new Promise((resolve) => {
			const request = indexedDB.deleteDatabase('flights-cache');
			request.onsuccess = request.onerror = request.onblocked = () => resolve();
		})
);

await page.goto(url);
await page.locator('[data-search-phase="settled"]').waitFor({ state: 'attached', timeout: 180_000 });
await page.locator('.result-card').first().locator('.trip-strip-unfold').click();
const detail = page.locator('.result-detail').first();
await detail.waitFor({ timeout: 30_000 });
if ((await detail.locator('.stay-picker, .stay-notice').count()) === 0) {
	await detail.locator('[data-segment="free-time"]').first().click();
}
const rows = page.locator('.alt-card');
await rows.first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(20_000);

console.log(`rows: ${await rows.count()}`);
console.log(`OSRM before the swap: ${osrm}`);
const before = osrm;
await rows.nth(1).click();
await page.waitForTimeout(25_000);
console.log(`OSRM one bed swap cost: ${osrm - before}`);
await browser.close();
