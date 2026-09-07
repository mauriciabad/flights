/**
 * Issues #436 and #438: which blocks on the trip strip are wide enough to print their own
 * figure, and where the landing-to-transport buffer is drawn.
 *
 *   node tools/probe-strip-figures.mjs 'http://localhost:4173' [minLayover=1200] [shots=<dir>] [--keep-cache]
 *
 * The width question cannot be reasoned about. The strip is square-root scaled inside
 * whatever the card is given, so a two-hour wait is about 31px of 335 on a phone and three
 * times that on a desktop, and whether "1h 30m" fits is a fact about a rendered box. This
 * prints every block's drawn width beside the stamp it is currently showing, at 375 and at
 * 1440, so the container-query thresholds in `TripStrip.svelte` are set against measurements
 * rather than against arithmetic.
 *
 * It also dumps the timeline's own walk-out row, which is the surface that prints the figure
 * when the block is too narrow to.
 *
 * Free providers only (Ryanair, OSRM, Transitous), its own Chromium, closed at the end.
 */
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const origin = process.argv[2] ?? 'http://localhost:4173';
const keepCache = process.argv.includes('--keep-cache');

const params = new URLSearchParams({
	dep: '2027-03-08',
	arr: '2027-03-27',
	from: 'BCN',
	to: 'TLL',
	fromLoc: 'Barcelona city centre@41.3851,2.1734',
	toLoc: 'Tallinn old town@59.4370,24.7536'
});
// Anything else the search form encodes, e.g. `minLayover=1200` for a connection long enough
// to book a bed in, which is the shape that puts a walk-out in front of the ride into town.
for (const argument of process.argv.slice(3)) {
	if (!argument.includes('=')) continue;
	const [key, ...rest] = argument.split('=');
	params.set(key, rest.join('='));
}
const url = `${origin}/results/?${params}`;

const flat = (text) => text.replace(/\s*\n\s*/g, ' | ').trim();

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();
page.on('pageerror', (error) => console.log('PAGE ERROR', String(error).slice(0, 300)));

await page.goto(origin);
if (!keepCache) {
	// The response cache is IndexedDB, so clearing site data does not touch it, and the PWA
	// service worker pins the previous build's entry chunk (AGENTS.md).
	await page.evaluate(async () => {
		for (const registration of await navigator.serviceWorker.getRegistrations()) {
			await registration.unregister();
		}
		for (const key of await caches.keys()) await caches.delete(key);
		await new Promise((resolve) => {
			const request = indexedDB.deleteDatabase('flights-cache');
			request.onsuccess = request.onerror = request.onblocked = () => resolve();
		});
	});
}

await page.goto(url);
// `data-search-phase="settled"` is written from a snapshot carrying `done`, so it is evidence
// the search happened rather than a wait satisfied by absence (issue #388).
await page.locator('[data-search-phase="settled"]').waitFor({ state: 'attached', timeout: 180_000 });

/** Where to drop a picture of the first card per viewport, when a run asks for one. */
const shotDir = process.argv.find((argument) => argument.startsWith('shots='))?.slice(6);

async function readStrip(width) {
	await page.setViewportSize({ width, height: 1000 });
	await page.waitForTimeout(400);
	const card = page.locator('.result-card').first();
	if ((await card.count()) === 0) {
		console.log(`\n===== ${width}px: no cards on screen, so this run proves nothing`);
		return;
	}
	if (shotDir) {
		const path = `${shotDir}/strip-${width}.png`;
		await card.screenshot({ path });
		console.log(`  SHOT     ${path}`);
	}

	const track = card.locator('.trip-strip-track').first();
	const blocks = await track.evaluateAll((tracks) => {
		const [first] = tracks;
		if (!first) return [];
		return [...first.querySelectorAll('.trip-strip-cell')].map((cell) => {
			const stamp = cell.querySelector('.trip-strip-stamp-time');
			const shown = stamp ? getComputedStyle(stamp).display !== 'none' : false;
			return {
				kind: [...cell.classList].find((name) => name.startsWith('trip-strip-cell-'))?.slice(16) ?? '?',
				width: Math.round(cell.getBoundingClientRect().width * 10) / 10,
				text: stamp?.textContent?.trim() ?? '',
				shown
			};
		});
	});

	console.log(`\n===== ${width}px, track ${Math.round(await track.evaluate((el) => el.getBoundingClientRect().width))}px`);
	for (const block of blocks) {
		const stamp = block.text ? `${block.shown ? 'PRINTS' : 'hidden'} "${block.text}"` : '';
		console.log(`  ${block.kind.padEnd(9)} ${String(block.width).padStart(6)}px  ${stamp}`);
	}

	const labels = await card.locator('.trip-strip-hit').evaluateAll((hits) =>
		hits.map((hit) => hit.getAttribute('aria-label') ?? '')
	);
	for (const label of labels) console.log(`  TARGET   ${label}`);
	console.log(`  SPOKEN   ${await card.locator('.trip-strip').first().getAttribute('aria-label')}`);
}

await readStrip(375);
await readStrip(1440);

// The timeline, which is where the walk-out prints its figure whatever the strip could fit.
await page.setViewportSize({ width: 1440, height: 1200 });
await page.locator('.result-card').first().locator('.trip-strip-unfold').click();
const detail = page.locator('.result-detail').first();
await detail.waitFor({ timeout: 30_000 });
const landings = detail.locator('.tl-row-landing');
console.log(`\n===== the timeline's walk-out rows: ${await landings.count()}`);
for (let index = 0; index < (await landings.count()); index += 1) {
	console.log(`  ROW ${index}  ${flat(await landings.nth(index).innerText())}`);
}
for (const segment of ['transfer-to-hotel', 'transfer-to-destination-location']) {
	const row = detail.locator(`[data-segment="${segment}"]`).first();
	if ((await row.count()) === 0) continue;
	console.log(`  ${segment.padEnd(34)} ${flat(await row.innerText())}`);
}

await browser.close();
