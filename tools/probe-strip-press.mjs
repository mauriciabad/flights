/**
 * Issue #456: whether the strip's press flag is still set when the press's own focus
 * arrives, and whether it has cleared by the time a keyboard focus deserves a preview.
 *
 *   node tests/e2e/support/static-server.mjs build 4931
 *   node tools/probe-strip-press.mjs http://localhost:4931 [--keep-cache] [--headed]
 *
 * `TripStrip` opens the hover preview on focus, except for the focus a press causes: on a
 * phone that press is a tap, and the popover would sit over the sheet the same tap opens.
 * Nothing on the focus event says which kind it is, so the strip carries a flag over the
 * length of one gesture, and the whole question is when that flag clears.
 *
 * How long a thumb stays on the glass is what decides it, so this presses and holds rather
 * than tapping. Playwright's own `tap()` sends `touchStart` and `touchEnd` in the same
 * millisecond, which is not a gesture any hand makes and is the one duration where every
 * version of this code passes. The presses here are dispatched through CDP with a real
 * hold between them.
 *
 * Each row prints the gesture with a clock on it, and the panel's state beside every
 * event. `timer(0)` is the probe's own zero-delay timer, queued from `pointerdown` exactly
 * as the strip's clear used to be: it is in the log because it is the explanation. Chromium
 * suppresses timer queues for the first 100ms after a `touchstart` and no longer, so a
 * press held past that mark runs the macrotask mid-gesture, long before the compatibility
 * `mousedown` that carries the focus.
 *
 * Three shapes, because the flag has two ways to be wrong:
 *
 *   1. presses of several lengths, where opening the preview is the defect,
 *   2. a focus afterwards, where NOT opening it is the defect, which is how a flag that
 *      strands would show,
 *   3. a press dragged into a scroll, which produces `pointercancel` and no compatibility
 *      events at all, followed by that same focus.
 *
 * Free providers only (Ryanair, OSRM, Transitous), its own Chromium, closed at the end.
 * It refuses to report when a fixture marker turns up in the page, for the reason
 * `tools/probe-results.mjs` gives at length. Exits non-zero on any of the three.
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

/** How long the thumb stays down, in milliseconds. The issue's own range for a real one is
 * 50 to 150, and 40 is roughly what `tap()` and a decisive flick do. */
const HOLDS = [40, 80, 120, 160, 240];

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
const context = await newProbeContext(browser, {
	viewport: { width: 375, height: 812 },
	hasTouch: true,
	isMobile: true,
	// Issue #308 scrolls the strip clear of the sheet, and a press aimed at a cell while it
	// is still travelling lands on whatever is over that spot right now. The app skips the
	// travel for a reader who asked for less motion, which makes the final position the only
	// position there is.
	reducedMotion: 'reduce'
});
const page = await context.newPage();
page.on('pageerror', (error) => console.log('PAGE ERROR', String(error).slice(0, 300)));

await page.goto(origin);
if (!keepCache) {
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
const hits = card.locator('.trip-strip-hit');
if ((await card.count()) === 0 || (await hits.count()) < 2) {
	console.log('No card with a strip on screen, so this run proves nothing.');
	await browser.close();
	process.exit(3);
}

/**
 * Every event that decides this, on the way down, with the panel's state read at each.
 *
 * The panel's own `toggle` event is deliberately not the witness. The HTML spec queues one
 * task per popover and replaces any task already queued, so a panel that opens and closes
 * inside one gesture dispatches a single `toggle` reading closed to closed, and the opening
 * this probe exists to catch leaves no event at all. `:popover-open` at each step does not
 * have that hole.
 */
async function record() {
	await page.evaluate(() => {
		const log = [];
		const stub = () => (document.querySelector('.stub:popover-open') ? 'open' : 'shut');
		const name = (node) =>
			node instanceof Element ? `${node.tagName.toLowerCase()}.${[...node.classList].slice(0, 3).join('.')}` : '';
		const types = ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'pointercancel', 'mousedown', 'focusin', 'mouseup', 'click'];
		const listeners = types.map((type) => {
			const listener = (event) => log.push({ t: performance.now(), type, stub: stub(), target: name(event.target) });
			document.addEventListener(type, listener, true);
			return [type, listener];
		});
		const timer = (event) => {
			if (event.pointerType === 'touch') setTimeout(() => log.push({ t: performance.now(), type: 'timer(0)', stub: stub(), target: '' }), 0);
		};
		document.addEventListener('pointerdown', timer, true);
		listeners.push(['pointerdown', timer]);
		Object.assign(window, {
			pressLog: log,
			stopRecording: () => {
				for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
			}
		});
	});
}

async function readLog() {
	const log = await page.evaluate(() => {
		window.stopRecording();
		return window.pressLog;
	});
	return log;
}

function print(title, entries) {
	console.log(`\n===== ${title}`);
	if (entries.length === 0) {
		console.log('  nothing was dispatched');
		return;
	}
	const start = entries[0].t;
	for (const entry of entries) {
		console.log(`  ${(entry.t - start).toFixed(0).padStart(5)}ms  ${entry.type.padEnd(13)} ${entry.stub.padEnd(5)} ${entry.target}`);
	}
}

/** The preview standing open at any point between the press and its click is the flicker
 * #456 is about: the panel the flag exists to suppress, over the sheet the press is
 * opening. */
function openedDuringGesture(entries) {
	const down = entries.findIndex((entry) => entry.type === 'pointerdown');
	if (down < 0) return false;
	const click = entries.findIndex((entry) => entry.type === 'click');
	return entries.slice(down, click < 0 ? entries.length : click + 1).some((entry) => entry.stub === 'open');
}

const cdp = await context.newCDPSession(page);

async function press(hit, hold, drag = false) {
	const box = await hit.boundingBox();
	if (!box) return [];
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await record();
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
	if (drag) {
		for (const dy of [12, 40, 90]) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - dy }] });
			await page.waitForTimeout(Math.max(10, Math.round(hold / 3)));
		}
	} else {
		await page.waitForTimeout(hold);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await page.waitForTimeout(400);
	return readLog();
}

/** Back to nothing selected, nothing focused and nothing open, so the next gesture starts
 * where the last one did. */
async function reset() {
	await page.keyboard.press('Escape');
	await page.evaluate(() => document.activeElement?.blur());
	await page.waitForTimeout(250);
}

const problems = [];

for (const hold of HOLDS) {
	const hit = hits.nth(0);
	await hit.scrollIntoViewIfNeeded();
	await page.waitForTimeout(200);
	const log = await press(hit, hold);
	print(`a thumb held ${hold}ms`, log);
	if (openedDuringGesture(log)) {
		problems.push(`a ${hold}ms press opened the preview`);
		console.log('  VERDICT        FAIL, the preview was up inside the gesture');
	} else {
		console.log('  VERDICT        ok, no preview inside the gesture');
	}
	await reset();
}

/** A keyboard focus after the gesture. `element.focus()` is what a test driver does and how
 * `segment-stub.spec.ts` reaches the keyboard case, so it is the shape that matters: a flag
 * that never cleared silences the preview for the rest of this card's life. */
async function focusOpensPreview(title) {
	await record();
	await hits.nth(1).evaluate((node) => node.focus());
	await page.waitForTimeout(300);
	// The `stub` column is read as each event is dispatched, and the strip opens the panel
	// from the focus handler, so the row for the focus itself cannot show the result of it.
	const opened = await page.evaluate(() => {
		const open = document.querySelector('.stub:popover-open') !== null;
		window.pressLog.push({ t: performance.now(), type: 'settled', stub: open ? 'open' : 'shut', target: '' });
		return open;
	});
	print(title, await readLog());
	console.log(opened ? '  VERDICT        ok, the preview opened' : '  VERDICT        FAIL, the flag is still set and the preview is silenced');
	if (!opened) problems.push(title);
	await reset();
}

await focusOpensPreview('a keyboard focus on the next segment, after a press');

// A press that turns into a scroll: `pointercancel`, and no compatibility events at all, so
// the only event a clear could hang on is that one.
await hits.nth(0).scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
print('a press dragged into a scroll', await press(hits.nth(0), 120, true));
await focusOpensPreview('a keyboard focus after the press became a scroll');

await browser.close();
console.log(problems.length === 0 ? '\nPASS: the flag covered every press and cleared after it.' : `\nFAIL: ${problems.join('; ')}.`);
process.exit(problems.length === 0 ? 0 : 1);
