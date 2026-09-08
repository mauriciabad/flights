/**
 * Which MapLibre canvases a results page holds while the route map is open, and how long
 * each of them lives (#455).
 *
 *   node tools/probe-map-canvases.mjs 'https://flights.mauri.app/results/?...'
 *
 * `route-map-absent-leg.spec.ts` asserted that opening the route dialog leaves the page with
 * exactly one MapLibre canvas, and found two about a quarter of the time. Two canvases is
 * worth taking seriously here. `tools/probe-map-cost.mjs` measured Chromium evicting the
 * oldest of more than sixteen live WebGL contexts, so a dialog that leaked one per open
 * walks a traveller into a blank map by their ninth.
 *
 * This says which two. It watches the DOM with a `MutationObserver` from before the first
 * preview is asked for, records every `canvas.maplibregl-canvas` as it arrives and leaves,
 * and reports each one's ancestry: inside the dialog, or inside the off-screen
 * `.map-snapshot-renderer` that photographs the ground previews.
 *
 * What it measured against production on 2026-09-08. The second canvas is the snapshot
 * renderer's, 360px wide against the dialog's 1175px. It arrives 16ms before the dialog's
 * does and leaves 7196ms after the dialog opened, which is `IDLE_RELEASE_MS` after the
 * capture that selecting a leg asked for. The app holds one dialog map. The spec was
 * counting a timer.
 *
 * A removed canvas has already lost its ancestors by the time an observer sees it, which is
 * why the log below prints `snapshot=false dialog=false` on every removal. Do not read that
 * as a third canvas.
 *
 * Observes only. It never answers a request, so every number here is production's.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const url = process.argv[2];
if (!url) {
	console.error("Usage: node tools/probe-map-canvases.mjs '<results URL>'");
	process.exit(2);
}

const markers = JSON.parse(
	readFileSync(path.join(repo, 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();

try {
	await page.goto(url, { waitUntil: 'domcontentloaded' });

	// The observer goes on before anything asks for a picture, so the first canvas of the
	// run is in the log rather than inferred from a later census.
	await page.evaluate(() => {
		const observed = [];
		window.__mapCanvasLog = observed;
		const startedAt = performance.now();
		// One insertion reaches this twice, as the node itself and again inside its parent's
		// subtree, and a log that says three canvases arrived is the confusion this exists to
		// end.
		const counted = new WeakSet();
		const note = (node, verb) => {
			if (verb === 'arrived') {
				if (counted.has(node)) return;
				counted.add(node);
			}
			observed.push({
				atMs: Math.round(performance.now() - startedAt),
				verb,
				snapshot: node.closest('.map-snapshot-renderer') !== null,
				dialog: node.closest('dialog') !== null
			});
		};
		const scan = (nodes, verb) => {
			for (const node of nodes) {
				if (!(node instanceof Element)) continue;
				if (node.matches('canvas.maplibregl-canvas')) note(node, verb);
				for (const inner of node.querySelectorAll('canvas.maplibregl-canvas')) note(inner, verb);
			}
		};
		new MutationObserver((records) => {
			for (const record of records) {
				scan(record.addedNodes, 'arrived');
				scan(record.removedNodes, 'left');
			}
		}).observe(document.documentElement, { childList: true, subtree: true });
	});

	await page.locator('[data-search-phase="settled"]').waitFor({ timeout: 60_000 });

	const body = await page.evaluate(() => document.body.innerText);
	const found = FIXTURE_TOKENS.filter((token) => body.includes(token));
	if (found.length > 0) {
		console.error(`MEASUREMENT INVALID: the page carries fixture markers (${found.join(', ')}).`);
		process.exit(1);
	}

	const card = page.locator('.result-card').first();
	await card.locator('.trip-strip-track').first().waitFor({ timeout: 30_000 });
	const stopover = card.locator('.trip-strip-hit-stopover').first();
	const cell = (await stopover.count()) > 0 ? stopover : card.locator('.trip-strip-hit-flight').first();
	await cell.click();
	const summary = page.locator('.customiser-trip-summary');
	await summary.waitFor({ timeout: 30_000 });
	if ((await page.locator('.customiser-trip[open]').count()) === 0) await summary.click();

	// The inspector draws the selected leg's picture and nothing else since #439, so the way
	// in is whichever timeline row has one. The ride to the airport is the leg every trip has;
	// the ride into town needs a stay, which needs a key nobody has to run a probe.
	await page.locator('.itinerary-timeline').waitFor({ timeout: 30_000 });
	const preview = page.locator('[data-testid="segment-customiser"] .ground-leg').first();
	let opened = false;
	for (const row of await page.locator('.itinerary-timeline [data-segment]').all()) {
		await row.click({ position: { x: 6, y: 6 } });
		if ((await preview.count()) > 0) {
			opened = true;
			break;
		}
	}
	if (!opened) {
		console.error('No leg of this trip has a picture, so there is no preview to open the map from.');
		process.exit(1);
	}
	await preview.click();
	const dialogCanvas = page.locator('dialog.route-dialog canvas.maplibregl-canvas');
	// The dialog element exists before MapLibre has built anything inside it, so waiting on
	// the dialog alone counts an empty page and reports no canvases at all.
	await dialogCanvas.waitFor({ timeout: 30_000 });

	const census = async (label) => {
		const rows = await page.evaluate(() =>
			[...document.querySelectorAll('canvas.maplibregl-canvas')].map((canvas) => ({
				snapshot: canvas.closest('.map-snapshot-renderer') !== null,
				dialog: canvas.closest('dialog') !== null,
				width: canvas.width
			}))
		);
		const where = (row) => (row.snapshot ? 'snapshot renderer' : row.dialog ? 'dialog' : 'loose');
		console.log(`${label}: ${rows.length} canvas(es)`);
		for (const row of rows) console.log(`  ${where(row)}, ${row.width}px wide`);
	};

	await census('With the dialog open');

	// How long the second one stays. `map-snapshot.svelte.ts` releases the hidden instance
	// `IDLE_RELEASE_MS` after its queue empties, and selecting a leg refills that queue, so
	// the wait is measured rather than assumed.
	const startedWaiting = Date.now();
	const hidden = page.locator('.map-snapshot-renderer canvas.maplibregl-canvas');
	await hidden.waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
	console.log(`\nThe hidden renderer left ${Date.now() - startedWaiting}ms after the census above.`);
	await census('Once it had gone');

	console.log('\nEvery canvas, as the page gained and lost it:');
	for (const row of await page.evaluate(() => window.__mapCanvasLog)) {
		console.log(`  ${String(row.atMs).padStart(6)}ms ${row.verb.padEnd(7)} snapshot=${row.snapshot} dialog=${row.dialog}`);
	}
} finally {
	await browser.close();
}
