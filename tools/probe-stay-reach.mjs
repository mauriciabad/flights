/**
 * Issue #405: what does putting a journey time on every stay row actually cost, and does the
 * row show one?
 *
 *   node tools/probe-stay-reach.mjs '<results url>' [--keep-cache]
 *
 * Answers three things, in a real browser against a real build, because `pnpm check` and
 * jsdom cannot see the class of bug that broke every search in production (AGENTS.md).
 *
 *   1. How many `routing.openstreetmap.de` requests the stay list costs, cold and then warm.
 *      That is the number the PR states. Counted between two marks rather than for the whole
 *      page, since the search itself routes the four itinerary legs and those are not this.
 *   2. What the rows actually print, so "43m" being on screen is evidence rather than a hope.
 *   3. Whether the sort control reorders the list, and whether the map's sidebar agrees with
 *      it about what "first" means.
 *
 * Its own Chromium, closed at the end, IndexedDB cleared unless told not to. Never the shared
 * MCP browser: it carries a dozen tabs and switches between them mid-measurement.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { PROBE_USER_AGENT } from './probe-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(
	readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const url = process.argv[2];
if (!url) throw new Error('pass a results URL');
const keepCache = process.argv.includes('--keep-cache');

const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: PROBE_USER_AGENT });
const page = await context.newPage();

let osrm = 0;
const osrmUrls = [];
page.on('request', (request) => {
	if (new URL(request.url()).host === 'routing.openstreetmap.de') {
		osrm += 1;
		osrmUrls.push(request.url());
	}
});
page.on('pageerror', (error) => console.log('PAGE ERROR', String(error).slice(0, 400)));
page.on('console', (message) => {
	if (message.type() === 'error') console.log('CONSOLE ERROR', message.text().slice(0, 400));
});

const origin = new URL(url).origin;
await page.goto(origin);
if (!keepCache) {
	await page.evaluate(
		() =>
			new Promise((resolve) => {
				const request = indexedDB.deleteDatabase('flights-cache');
				request.onsuccess = request.onerror = request.onblocked = () => resolve();
			})
	);
}

await page.goto(url);
await page
	.locator('[data-search-phase="settled"]')
	.waitFor({ state: 'attached', timeout: 180_000 });

const bodyText = await page.evaluate(() => document.body.innerText);
const leaked = FIXTURE_TOKENS.filter((token) => bodyText.includes(token));
if (leaked.length > 0) {
	console.log('MEASUREMENT INVALID: fixture markers on the page:', leaked.join(', '));
	if (process.env.SHOT) {
	await page.locator('.stay-alternatives-list').first().screenshot({ path: process.env.SHOT });
	console.log(`\nscreenshot written to ${process.env.SHOT}`);
}

await browser.close();
	process.exit(2);
}

await page.locator('.result-card').first().locator('.trip-strip-unfold').click();
const detail = page.locator('.result-detail').first();
await detail.waitFor({ timeout: 30_000 });

// The mark goes BEFORE the panel opens, not after the rows appear. The lookup starts the
// moment the picker mounts, so a mark taken once rows are on screen has already missed the
// requests it is there to count. The first version of this probe did exactly that and
// reported the list as free.
const beforeReach = osrm;

// The stay picker lives on the free-time segment's panel.
if ((await detail.locator('.stay-picker, .stay-notice').count()) === 0) {
	await detail.locator('[data-segment="free-time"]').first().click();
}
const picker = page.locator('.stay-picker');
if ((await picker.count()) === 0) {
	console.log('NO STAY PICKER on this itinerary; nothing to measure');
	if (process.env.SHOT) {
	await page.locator('.stay-alternatives-list').first().screenshot({ path: process.env.SHOT });
	console.log(`\nscreenshot written to ${process.env.SHOT}`);
}

await browser.close();
	process.exit(3);
}

const rows = page.locator('.alt-card');
await rows.first().waitFor({ timeout: 30_000 });
const rowCount = await rows.count();
// Long enough for two table requests through the adapter's own 1100ms queue with the
// search's tail still draining, and short enough that a hung fetch still gets reported.
for (let elapsed = 0; elapsed < 30_000; elapsed += 500) {
	await page.waitForTimeout(500);
	const withTimes = await page.locator('.alt-card .reach-time').count();
	if (withTimes > 0) break;
}
const coldRequests = osrm - beforeReach;

const flat = (value) => value.replace(/\s*\n\s*/g, ' | ').trim();
console.log(`\nROWS: ${rowCount}`);
console.log(`OSRM requests for the search itself: ${beforeReach}`);
console.log(`OSRM requests the stay list cost (cold): ${coldRequests}`);
for (const request of osrmUrls.slice(beforeReach)) {
	const parsed = new URL(request);
	const destinations = parsed.searchParams.get('destinations');
	console.log(
		`  ${parsed.pathname.split('/').slice(1, 3).join('/')} destinations=${destinations ? destinations.split(';').length : 'n/a'}`
	);
}

console.log('\nFIRST FIVE ROWS');
for (let index = 0; index < Math.min(5, rowCount); index += 1) {
	console.log(`  ${flat(await rows.nth(index).innerText())}`);
}

const note = page.locator('[data-testid="stay-reach-note"]');
console.log(`\nREACH NOTE: ${(await note.count()) > 0 ? flat(await note.innerText()) : '(none)'}`);
const failures = page.locator('[data-testid="stay-reach-failure"]');
for (let index = 0; index < (await failures.count()); index += 1) {
	console.log(`REACH FAILURE: ${flat(await failures.nth(index).innerText())}`);
}

const sort = page.locator('.stay-sort select');
if ((await sort.count()) === 0) {
	console.log('\nNO SORT CONTROL offered (fewer than two usable keys)');
} else {
	const options = await sort.locator('option').allTextContents();
	console.log(`\nSORT KEYS: ${options.join(', ')}`);
	const nameOf = async (locator) => (await locator.locator('.alt-card-name').allTextContents()).slice(0, 4);
	console.log(`  recommended: ${(await nameOf(rows)).join(' / ')}`);
	for (const value of await sort.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value))) {
		if (value === 'recommended') continue;
		await sort.selectOption(value);
		await page.waitForTimeout(150);
		console.log(`  ${value}: ${(await nameOf(rows)).join(' / ')}`);
	}
	// The map's sidebar renders the same list; if it disagrees, "first" means two things.
	await sort.selectOption('recommended');
	await page.waitForTimeout(150);
}

await page.locator('.stay-map-open').click();
const sidebar = page.locator('[data-testid="stays-sidebar"]');
await sidebar.waitFor({ timeout: 15_000 });
const sidebarNames = (await sidebar.locator('.stays-row-name').allTextContents()).slice(0, 4);
console.log(`\nMAP SIDEBAR ORDER: ${sidebarNames.join(' / ')}`);
console.log(`SIDEBAR FIRST ROW: ${flat(await sidebar.locator('.stays-row').first().innerText())}`);

// The detail panel is the surface with room for the modes that produced no time, which is
// issue #405's "visibly marked as not having".
await sidebar.locator('.stays-row').first().click();
await sidebar.locator('.stays-detail-reach').waitFor({ timeout: 10_000 });
console.log('DETAIL REACH:');
for (const line of await sidebar.locator('.stays-detail-reach li').allTextContents()) {
	console.log(`  ${line}`);
}
await page.keyboard.press('Escape');

// What swapping to another bed costs, which is the number a thin cache entry could have
// changed: `getCachedRoute` treats a duration-only entry (the table writes those) as a miss,
// so a bed the list has already routed still fetches a full road route when it is picked.
const beforeSwap = osrm;
if (rowCount > 1) {
	await rows.nth(1).click();
	for (let elapsed = 0; elapsed < 25_000; elapsed += 500) {
		await page.waitForTimeout(500);
		if (osrm > beforeSwap) break;
	}
	await page.waitForTimeout(5000);
}
console.log(`\nOSRM requests one bed swap cost: ${osrm - beforeSwap}`);

// Warm: the 30-day route cache should answer the whole list without a request.
const beforeReload = osrm;
await page.reload();
await page
	.locator('[data-search-phase="settled"]')
	.waitFor({ state: 'attached', timeout: 180_000 });
await page.locator('.result-card').first().locator('.trip-strip-unfold').click();
const detailAgain = page.locator('.result-detail').first();
await detailAgain.waitFor({ timeout: 30_000 });
if ((await detailAgain.locator('.stay-picker').count()) === 0) {
	await detailAgain.locator('[data-segment="free-time"]').first().click();
}
await page.locator('.alt-card').first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(4000);
console.log(`\nOSRM requests on the reload, whole page: ${osrm - beforeReload}`);
console.log(`OSRM requests in total: ${osrm}`);

if (process.env.SHOT) {
	await page.locator('.stay-alternatives-list').first().screenshot({ path: process.env.SHOT });
	console.log(`\nscreenshot written to ${process.env.SHOT}`);
}

await browser.close();
