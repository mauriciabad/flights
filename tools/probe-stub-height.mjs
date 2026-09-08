/**
 * Issue #457: where the segment stub's top edge lands when the panel is taller than the
 * room the strip leaves it.
 *
 *   node tests/e2e/support/static-server.mjs build 4931
 *   node tools/probe-stub-height.mjs http://localhost:4931 [--keep-cache] [--headed]
 *
 * `SegmentStub.place()` caps the counterfoil with `--stub-body-max` so a panel that does
 * not fit still fits. Whether the cap is the right number is a fact about a rendered box.
 * It depends on the height the tinted top half's words wrap to, on `.stub-bottom`'s own
 * padding and borders, and on the browser's own rounding. None of that exists in jsdom and
 * none of it can be read off the stylesheet.
 *
 * The room the panel gets is `cell.top - GAP - EDGE`, so this scrolls the strip to a set
 * of distances from the top of the window and reads the panel at each. That is what makes
 * the run repeatable: which itinerary the live search returns today decides how tall the
 * panel is, and sweeping the room means the cap engages whatever came back. A run where it
 * never engaged proves nothing and says so.
 *
 * Each row prints the room, the height `place` measured, the cap it wrote, the height the
 * panel settled at and its top edge. `EDGE` is 8, so a top above 8 is the eyebrow running
 * off the window, and the eyebrow is the one line the panel's own comment says never
 * scrolls.
 *
 * Free providers only (Ryanair, OSRM, Transitous), its own Chromium, closed at the end.
 * It refuses to report when a fixture marker turns up in the page, for the reason
 * `tools/probe-results.mjs` gives at length. Exits non-zero when a panel hangs off either
 * edge of the window.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8'));
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const origin = process.argv[2] ?? 'http://localhost:4931';
const keepCache = process.argv.includes('--keep-cache');
const headed = process.argv.includes('--headed');

/** `SegmentStub.svelte`'s own constants. */
const GAP = 8;
const EDGE = 8;

/** How far inside and outside the panel's own height to aim each case. 40px is comfortably
 * more than the box `.stub-bottom` puts around the counterfoil, so "short" really is short
 * of the room and "roomy" really has room. */
const MARGIN = 40;

/** A layover long enough to sleep in, so the stopover panel carries a bed and the free-day
 * cells exist at all. The same route and dates `tools/probe-strip-figures.mjs` uses. */
const params = new URLSearchParams({
	dep: '2027-03-08',
	arr: '2027-03-27',
	from: 'BCN',
	to: 'TLL',
	fromLoc: 'Barcelona city centre@41.3851,2.1734',
	toLoc: 'Tallinn old town@59.4370,24.7536',
	minLayover: '1200'
});
const url = `${origin}/results/?${params}`;

const browser = await chromium.launch({ headless: !headed });
const context = await newProbeContext(browser, { viewport: { width: 375, height: 812 } });
const page = await context.newPage();
page.on('pageerror', (error) => console.log('PAGE ERROR', String(error).slice(0, 300)));

await page.goto(origin);
if (!keepCache) {
	// The response cache is IndexedDB, so clearing site data does not touch it, and the PWA
	// service worker pins the previous build's entry chunk (AGENTS.md).
	await page.evaluate(async () => {
		for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
		for (const key of await caches.keys()) await caches.delete(key);
		await new Promise((resolve) => {
			const request = indexedDB.deleteDatabase('flights-cache');
			request.onsuccess = request.onerror = request.onblocked = () => resolve();
		});
	});
}

await page.goto(url);
await page.locator('[data-search-phase="settled"]').waitFor({ state: 'attached', timeout: 180_000 });

const text = await page.evaluate(() => document.body.innerText);
const found = FIXTURE_TOKENS.filter((token) => text.includes(token));
if (found.length > 0) {
	console.log(`!!! MEASUREMENT INVALID: this page was served fixture data (${found.join(', ')}).`);
	await browser.close();
	process.exit(2);
}

const card = page.locator('.result-card').first();
const stopover = card.locator('.trip-strip-hit-stopover');
if ((await card.count()) === 0 || (await stopover.count()) === 0) {
	console.log('No card with a stopover on screen, so this run proves nothing.');
	await browser.close();
	process.exit(3);
}

/** The app shell scrolls inside `.app-content`, not the document, and any scroll closes an
 * open panel. So the strip is put where it is wanted first and hovered afterwards. */
async function putStripAt(offset) {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const box = await stopover.boundingBox();
		if (!box) return null;
		const delta = Math.round(box.y - offset);
		if (Math.abs(delta) <= 1) return box;
		const moved = await page.evaluate((by) => {
			const scroller = document.querySelector('.app-content') ?? document.scrollingElement;
			const before = scroller.scrollTop;
			scroller.scrollTop += by;
			return scroller.scrollTop - before;
		}, delta);
		if (moved === 0) return await stopover.boundingBox();
		await page.waitForTimeout(60);
	}
	return await stopover.boundingBox();
}

async function shut() {
	await page.mouse.move(2, 2);
	await page.waitForFunction(() => !document.querySelector('.stub:popover-open'), null, { timeout: 5_000 });
}

/** Where the panel comes to rest. The 4px entry rise is a `transform` on top of the
 * `translate` that carries the placement, so a box read on the frame it opens is 4px from
 * the one a reader sees. */
async function settled() {
	await page.waitForFunction(
		() => {
			const panel = document.querySelector('.stub:popover-open');
			if (!panel) return false;
			const { transform } = getComputedStyle(panel);
			return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
		},
		null,
		{ timeout: 10_000 }
	);
}

/** Everything `place` had to work with, and everything it produced. */
function read(cell) {
	return page.evaluate(
		({ cell, GAP, EDGE }) => {
			const panel = document.querySelector('.stub:popover-open');
			if (!panel) return null;
			const body = panel.querySelector('.stub-body');
			const box = panel.getBoundingClientRect();
			const eyebrow = panel.querySelector('.stub-eyebrow').getBoundingClientRect();
			return {
				cell: `${Math.round(cell.y)}..${Math.round(cell.y + cell.height)}`,
				roomAbove: Math.round(cell.y - GAP - EDGE),
				roomBelow: Math.round(window.innerHeight - (cell.y + cell.height) - GAP - EDGE),
				side: panel.classList.contains('is-below') ? 'below' : 'above',
				bodyMax: panel.style.getPropertyValue('--stub-body-max'),
				y: panel.style.getPropertyValue('--y'),
				settledHeight: Math.round(box.height),
				topHalf: Math.round(panel.querySelector('.stub-top').getBoundingClientRect().height),
				bodyBox: Math.round(body.getBoundingClientRect().height),
				bodyWanted: body.scrollHeight,
				panel: `${Math.round(box.top)}..${Math.round(box.bottom)}`,
				top: Math.round(box.top),
				bottom: Math.round(box.bottom),
				eyebrowTop: Math.round(eyebrow.top),
				windowHeight: window.innerHeight
			};
		},
		{ cell, GAP, EDGE }
	);
}

// The panel's own height decides which distances are interesting, and today's live search
// decides the panel's height. So it is measured once with the strip low on the screen,
// where the whole panel certainly fits above it, and every case below is derived from it.
const first = await putStripAt(Math.round((await page.evaluate(() => window.innerHeight)) * 0.85));
if (!first) {
	console.log('The strip would not scroll into view.');
	await browser.close();
	process.exit(3);
}
await stopover.hover();
await settled();
const intrinsic = await read(first);
await shut();
if (!intrinsic || intrinsic.bodyMax !== 'none') {
	console.log('The panel never opened uncapped, so its own height is unknown.');
	await browser.close();
	process.exit(3);
}

const windowHeight = intrinsic.windowHeight;
const cellHeight = Math.round(first.height);
const H = intrinsic.settledHeight;
/** A distance from the top of the window that leaves exactly `room` above the cell. */
const forRoomAbove = (room) => room + GAP + EDGE;
/** The same, for the room under it. */
const forRoomBelow = (room) => windowHeight - EDGE - GAP - room - cellHeight;
const CASES = [
	['room to spare above', forRoomAbove(H + MARGIN)],
	['short above, so the counterfoil is capped', forRoomAbove(H - MARGIN)],
	['short below, so the counterfoil is capped', forRoomBelow(H - MARGIN)],
	['room to spare below', forRoomBelow(H + MARGIN)]
];

console.log(`\nThis panel stands ${H}px in a ${windowHeight}px window, over a ${cellHeight}px cell.`);

let failures = 0;
let capped = 0;

for (const [title, offset] of CASES) {
	const cell = await putStripAt(Math.round(offset));
	if (!cell) {
		console.log(`\n===== ${title}: the hit target left the page`);
		continue;
	}
	await stopover.hover();
	await settled();
	const reading = await read(cell);
	console.log(`\n===== ${title}, hit target at y=${Math.round(cell.y)}`);
	if (!reading) {
		console.log('  the panel never opened');
		await shut();
		continue;
	}
	for (const [key, value] of Object.entries(reading)) console.log(`  ${key.padEnd(13)} ${value}`);
	const over = EDGE - reading.top;
	const under = reading.bottom - (reading.windowHeight - EDGE);
	if (reading.bodyMax !== 'none' && reading.bodyMax !== '') capped += 1;
	if (over > 0) {
		failures += 1;
		console.log(`  VERDICT       FAIL, ${over}px above the ${EDGE}px edge, the eyebrow with it`);
	} else if (under > 0) {
		failures += 1;
		console.log(`  VERDICT       FAIL, ${under}px below the ${EDGE}px edge`);
	} else {
		console.log('  VERDICT       ok, the whole panel is on screen');
	}
	await shut();
}

await browser.close();

if (capped === 0) {
	console.log('\nThe cap never engaged, so this run says nothing about it. Try a shorter window.');
	process.exit(3);
}
console.log(failures === 0 ? `\nPASS: ${capped} capped placements, all on screen.` : `\nFAIL: ${failures} placements hang off the window.`);
process.exit(failures === 0 ? 0 : 1);
