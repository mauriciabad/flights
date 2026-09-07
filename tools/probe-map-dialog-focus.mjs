/**
 * Reads what has focus inside an open `MapDialog`, before and after a click on the map.
 *
 * Issue #448. `pnpm check`, the unit suite and jsdom cannot see this at all: it is a
 * browser deciding where focus goes when a click lands on something that cannot take it,
 * and then deciding whether to paint a ring. Both decisions are Chrome's, and neither
 * exists outside a real one.
 *
 * The two facts this reports, and they are separate mechanisms:
 *
 * 1. `showModal()` focuses the DIALOG itself when no descendant claims focus first. So a
 *    keyboard reader starts on a container rather than on a control.
 * 2. A click on a non-focusable descendant sends focus back to the dialog, because a modal
 *    dialog is the focus scope and focus cannot leave it. `app.css` then draws this app's
 *    2px accent outline 2px outside a near-fullscreen surface, which is the ring around the
 *    whole viewport the issue is named after.
 *
 * `dialogMatchesFocusVisible` is the load-bearing number, and it is read AFTER a keystroke.
 * A mouse click alone does not arm `:focus-visible`; the ring appears on the next key press,
 * which is why this looked like a keyboard bug and is not one.
 *
 * ## What it mounts
 *
 * A temporary SvelteKit route holding one real `MapDialog` with one real MapLibre map in
 * its `map` snippet and static text in its `panel`, written before the run and deleted
 * after it. `RouteMapDialog`, `StaysMapDialog` and `ConnectionsMapDialog` each render
 * `MapDialog` and declare no `<dialog>` of their own, so the surface measured here is
 * literally the surface all three open. Driving one of them instead would need a whole
 * itinerary or a priced stay list mocked, and a probe that answers its own mocks is the
 * trap AGENTS.md's "Mocks belong to a test" section is about.
 *
 * Nothing here intercepts a request. The basemap comes from CARTO through the app's own
 * `MAP_STYLE_URL`, keyless and free, the same style every map in this app draws.
 *
 * Usage: node tools/probe-map-dialog-focus.mjs [--headed]
 * Screenshots land in docs/screenshots/448-map-dialog-focus-*.png.
 */
import { chromium } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { newProbeContext } from './probe-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const routeDir = path.join(repo, 'src', 'routes', 'probe-map-dialog-focus');
const shots = path.join(repo, 'docs', 'screenshots');
const headed = process.argv.includes('--headed');
/** The trailing slash matters: this app redirects 308 without it, and a probe that followed
 * that redirect would measure a page it did not mean to load. */
const ROUTE = '/probe-map-dialog-focus/';

/** A port the OS just told us is free, rather than a number picked in advance. AGENTS.md: a
 * dozen worktrees on this machine pick ports independently, and a run that attaches to
 * somebody else's server measures somebody else's branch. */
async function freePort() {
	if (process.env.PROBE_PORT) return Number(process.env.PROBE_PORT);
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

const pageSource = `<script lang="ts">
	import { MapDialog } from '$lib/components';
	import { MAP_STYLE_URL } from '$lib/itinerary-map/style';

	let open = $state(false);

	function mountMap(container: HTMLDivElement) {
		let instance: { remove: () => void } | undefined;
		void (async () => {
			await import('maplibre-gl/dist/maplibre-gl.css');
			const { Map } = await import('maplibre-gl');
			instance = new Map({
				container,
				style: MAP_STYLE_URL.dark,
				center: [-0.09, 51.49],
				zoom: 12,
				attributionControl: false
			});
		})();
		return () => instance?.remove();
	}
</script>

<main>
	<button type="button" class="probe-open" onclick={() => (open = true)}>Open the map</button>
</main>

{#if open}
	<MapDialog title="Probe map dialog" onclose={() => (open = false)} class="probe-dialog">
		{#snippet map()}
			<div class="probe-map" {@attach mountMap}></div>
		{/snippet}
		{#snippet panel()}
			<p class="probe-panel-text">Static text, which cannot take focus either.</p>
		{/snippet}
	</MapDialog>
{/if}

<style>
	main {
		display: grid;
		place-items: center;
		min-height: 100dvh;
		background: var(--color-bg);
	}

	.probe-map {
		height: 100%;
		width: 100%;
	}
</style>
`;

/** What has focus, in the terms a reader of this report can act on. */
const ACTIVE = () => {
	const active = document.activeElement;
	if (!active) return 'nothing';
	const name = active.tagName;
	const className = typeof active.className === 'string' ? active.className : '';
	return className ? `${name}.${className.trim().split(/\s+/).join('.')}` : name;
};

let vite;

async function main() {
	await mkdir(routeDir, { recursive: true });
	await mkdir(shots, { recursive: true });
	await writeFile(path.join(routeDir, '+page.svelte'), pageSource);

	const port = await freePort();
	vite = spawn('pnpm', ['exec', 'vite', 'dev', '--port', String(port), '--strictPort'], {
		cwd: repo,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	// `localhost` rather than `127.0.0.1`: vite binds the loopback name, which on this
	// machine resolves to ::1 first, and a probe pointed at the v4 address is refused.
	const origin = `http://localhost:${port}`;
	vite.stdout.on('data', () => {});
	vite.stderr.on('data', (chunk) => process.stderr.write(chunk));
	// Polled rather than read off stdout. Vite prints "ready in" before the route is
	// answerable, and a probe that raced it reported a connection refused as a broken page.
	const deadline = Date.now() + 90_000;
	for (;;) {
		try {
			const response = await fetch(`${origin}${ROUTE}`);
			if (response.ok) break;
		} catch {
			if (Date.now() > deadline) throw new Error('vite did not answer in 90s');
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	const browser = await chromium.launch({ headless: !headed });
	// Dark by default, because the app is dark-first around #0b1020 and a run that only ever
	// looked at light mode would be checking the half nobody sees first.
	const context = await newProbeContext(browser, {
		viewport: { width: 1100, height: 800 },
		colorScheme: 'dark'
	});
	const page = await context.newPage();

	const consoleErrors = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => consoleErrors.push(String(error)));

	const report = {};
	await page.goto(`${origin}${ROUTE}`, { waitUntil: 'networkidle' });

	// Clicked until the dialog answers, because Playwright waits for an element to be
	// visible and not for SvelteKit to have hydrated it. The first run of this probe clicked
	// a button with no handler on it yet and reported a dialog that never opened.
	const dialogOpens = async () => {
		await page.locator('.probe-open').click();
		return (await page.locator('dialog.probe-dialog').count()) > 0;
	};
	for (let attempt = 0; attempt < 20 && !(await dialogOpens()); attempt += 1) {
		await page.waitForTimeout(250);
	}
	const dialog = page.locator('dialog.probe-dialog');
	// The reason the failure is caught and re-thrown: a component that failed to compile
	// leaves an empty page, and Playwright's own timeout says only "not visible". The
	// console line says which import was wrong.
	await dialog.waitFor().catch((cause) => {
		throw new Error(`the dialog never opened. console: ${JSON.stringify(consoleErrors)}`, { cause });
	});
	report.opened = await dialog.evaluate((element) => element.open);
	report.focusOnOpen = await page.evaluate(ACTIVE);

	// The map's own canvas, which MapLibre creates and gives `tabindex="0"`. Waiting for it
	// rather than for tiles: this measures focus, and a canvas with no tiles on it is the
	// same click target as one with tiles on it.
	const canvas = page.locator('dialog.probe-dialog canvas.maplibregl-canvas');
	await canvas.waitFor({ timeout: 30_000 });

	/** Where focus is, and whether the dialog is wearing a ring, after one gesture. The key
	 * press is not decoration. `:focus-visible` is armed by keyboard modality, so a click
	 * alone leaves the ring unpainted and the next keystroke paints it. */
	const afterClicking = async (locator, position) => {
		await locator.click({ position });
		const afterClick = await page.evaluate(ACTIVE);
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(100);
		return {
			focusAfterClick: afterClick,
			focusAfterKey: await page.evaluate(ACTIVE),
			...(await page.evaluate(() => {
				const element = document.querySelector('dialog.probe-dialog');
				const style = getComputedStyle(element);
				const box = element.getBoundingClientRect();
				return {
					dialogMatchesFocusVisible: element.matches(':focus-visible'),
					dialogOutline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
					ringWouldSurround: `${Math.round(box.width)}x${Math.round(box.height)} of ${window.innerWidth}x${window.innerHeight}`
				};
			}))
		};
	};

	// The middle of the map, which is the gesture the issue is named after: panning it.
	report.mapClick = await afterClicking(canvas, { x: 300, y: 200 });
	await page.screenshot({ path: path.join(shots, '448-map-dialog-focus-after-map-click-dark-1100.png') });

	// The panel's static text, the same shape of click one row down. `RouteMapDialog` has no
	// panel; the other two do, and every word in them is as unfocusable as the map.
	report.panelClick = await afterClicking(page.locator('.probe-panel-text'), { x: 10, y: 5 });

	// The title, which is inside the head rather than the body, so a fix that only covered
	// the body would still leave this one painting a ring.
	report.titleClick = await afterClicking(page.locator('.map-dialog-title'), { x: 10, y: 5 });

	// The answer to "never `outline: none` without a focus replacement". Focus is on the
	// dialog at this point and wearing no ring, so what matters is that one Tab from there
	// reaches a control that does wear one. Read rather than assumed, because the whole
	// reason this app is measured in a browser is that focus order is the browser's opinion.
	await page.keyboard.press('Tab');
	await page.waitForTimeout(100);
	report.oneTabFromTheDialog = {
		focus: await page.evaluate(ACTIVE),
		outline: await page.evaluate(() => {
			const active = document.activeElement;
			if (!active) return 'nothing focused';
			const style = getComputedStyle(active);
			return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
		}),
		matchesFocusVisible: await page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false)
	};

	await page.emulateMedia({ colorScheme: 'light' });
	await page.waitForTimeout(150);
	await page.screenshot({ path: path.join(shots, '448-map-dialog-focus-after-map-click-light-1100.png') });
	await page.emulateMedia({ colorScheme: null });

	// Escape has to keep working, and focus has to come back to what opened the dialog.
	// Both are `open-as-modal.ts`'s job and both are easy to break while moving focus around.
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	report.closedOnEscape = (await page.locator('dialog.probe-dialog').count()) === 0;
	report.focusAfterClose = await page.evaluate(ACTIVE);

	// `/sw.js` 404s under `vite dev` because the service worker is only built for production.
	// Reporting it every run would train a reader to skim this list.
	report.consoleErrors = consoleErrors.filter((line) => !line.includes('(404)'));

	console.log(JSON.stringify(report, null, 2));

	await browser.close();
}

try {
	await main();
} finally {
	// Both, always. AGENTS.md counted fourteen dev servers left listening on this machine one
	// morning, every one of them a port a later run can silently attach to.
	vite?.kill('SIGTERM');
	await rm(routeDir, { recursive: true, force: true });
}
