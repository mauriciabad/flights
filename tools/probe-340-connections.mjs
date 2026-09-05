/**
 * Issue #340: which stopover cities the acceptance route actually puts on screen, and what
 * asking for them cost.
 *
 *   node tools/probe-340-connections.mjs <results url>
 *
 * `tools/probe-connection-cities.mjs` answers the first half already. This one exists for
 * the second: it splits Kiwi's traffic into the two questions #340 is about — the
 * everywhere query (`OnePerCityItinerariesQuery`), the pair check (`DirectRouteCheckQuery`)
 * and the fare search (`SearchOneWayItinerariesQuery`) — so a claim about what the fix costs
 * can be read off a real load rather than argued from the code.
 *
 * Waits on `data-search-phase="settled"`, the positive signal issue #337 added. Never on the
 * absence of "still searching", which is satisfied by a page that has not started.
 *
 * Refuses to report anything if a fixture marker appears in the page or in a provider
 * response, the same rule `tools/probe-results.mjs` follows.
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

const url = process.argv[2];
if (!url) {
	console.error('usage: node tools/probe-340-connections.mjs <results-url>');
	process.exit(2);
}

const browser = await chromium.launch();
const context = await browser.newContext({
	// Playwright's headless UA says "HeadlessChrome", which Kiwi's public endpoint answers
	// with a 403 carrying no CORS headers. Probing with the default measures a provider
	// failing for a reason no visitor will ever hit.
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
});
const page = await context.newPage();

const requests = [];
const bodies = [];
page.on('response', (response) => {
	const responseUrl = response.url();
	if (responseUrl.startsWith(new URL(url).origin) || responseUrl.startsWith('data:')) return;
	requests.push({ status: response.status(), url: responseUrl });
	if (!/^https?:/.test(responseUrl)) return;
	bodies.push(
		response
			.text()
			.then((text) => text.slice(0, 20000))
			.catch(() => '')
	);
});

await page.goto(url);
await page.evaluate(() => indexedDB.deleteDatabase('flights-cache'));
await page.goto(url);
await page
	.locator('[data-search-phase="settled"]')
	.waitFor({ state: 'attached', timeout: 180000 });

const pageText = await page.locator('body').innerText();
const responseText = (await Promise.all(bodies)).join('\n');
const leaked = FIXTURE_TOKENS.filter(
	(token) => pageText.includes(token) || responseText.includes(token)
);
if (leaked.length > 0) {
	console.error(`MEASUREMENT INVALID: fixture markers on screen or on the wire: ${leaked.join(', ')}`);
	await browser.close();
	process.exit(1);
}

const cities = await page.$$eval('.route-leg-stopover', (legs) =>
	legs.map((leg) => leg.textContent.trim()).filter(Boolean)
);
const headline = /\d+ of \d+ itiner\w*/.exec(pageText)?.[0] ?? '(no itinerary count on screen)';

const count = (needle) => requests.filter((r) => r.url.includes(needle)).length;

console.log(`url          ${url}`);
console.log(`headline     ${headline}`);
console.log(`connections  ${[...new Set(cities)].join(', ') || '(none)'}`);
console.log(`requests     ${requests.length} total`);
console.log(`  kiwi everywhere  ${count('OnePerCityItinerariesQuery')}`);
console.log(`  kiwi pair check  ${count('DirectRouteCheckQuery')}`);
console.log(`  kiwi fares       ${count('SearchOneWayItinerariesQuery')}`);
console.log(`  ryanair          ${count('ryanair.com')}`);
const failures = requests.filter((r) => r.status >= 400);
if (failures.length > 0) {
	console.log('non-2xx responses:');
	for (const failure of failures.slice(0, 15)) console.log(`  ${failure.status} ${failure.url}`);
}

await browser.close();
