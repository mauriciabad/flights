/**
 * Answers one question: does a returning visitor get the build we just deployed?
 *
 * The app is a PWA, so a returning visitor is served by a service worker, not by the
 * network. That worker decides which build they see, and for a while it decided wrong:
 * `registerType: 'prompt'` left a freshly-installed worker sitting in `waiting` until
 * somebody clicked a toast, so anyone who did not click kept the old shell. The owner
 * spent a day reporting bugs against code we had already replaced.
 *
 * This reproduces the situation for real rather than reasoning about config:
 *
 *   1. build the tree twice, tagging each build with a marker in app.html (version A
 *      and version B), so the two builds differ the way a deploy differs — every
 *      prerendered page changes, so every precache revision in sw.js changes too;
 *   2. serve A at an origin and visit it in a fresh Chromium until the worker controls
 *      the page, which is what makes anything after it a *returning* visit;
 *   3. swap the same origin over to B. No rebuilt browser, no cleared storage, no
 *      unregistered worker, because a real person clears nothing;
 *   4. see which build the visitor ends up on, and how long it took, in two shapes:
 *      one who comes back and loads a page, and one who never left — a tab sitting
 *      open on results while a deploy lands underneath it;
 *   5. shut the server down and reload, because the whole point of a service worker is
 *      that the shell still comes up with nothing to connect to.
 *
 * Usage:
 *   node tools/probe-sw-update.mjs [--port 4399] [--wait 20000] [--screenshot path.png]
 *
 * Exits non-zero when a visitor is still on A, which is the bug.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { newProbeContext } from './probe-browser.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const appHtmlPath = join(repoRoot, 'src/app.html');

function flag(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
}

const port = Number(flag('port', 4399));
const origin = `http://127.0.0.1:${port}`;
const settleMs = Number(flag('wait', 20_000));
let screenshotPath = flag('screenshot', undefined);

// The marker sits in app.html's <body>, outside %sveltekit.body%, so Svelte never
// hydrates over it and there is no hydration mismatch to explain away. It is also in
// every prerendered page rather than in one route's bundle, which is what makes the two
// builds differ everywhere a real deploy differs.
const ANCHOR = '<div style="display: contents">%sveltekit.body%</div>';

function markedAppHtml(original, version) {
	if (!original.includes(ANCHOR)) {
		throw new Error(
			`src/app.html no longer contains the anchor this probe patches:\n  ${ANCHOR}\n` +
				'Update ANCHOR in tools/probe-sw-update.mjs to match.'
		);
	}
	const banner =
		`<div id="probe-build" data-version="${version}" style="position:fixed;inset:0 0 auto 0;` +
		`z-index:99999;background:#ff00aa;color:#000;font:700 16px/2 ui-monospace,monospace;` +
		`text-align:center">BUILD ${version}</div>`;
	return original.replace(ANCHOR, `${banner}\n\t\t${ANCHOR}`);
}

function build(version, outDir) {
	const original = readFileSync(appHtmlPath, 'utf8');
	try {
		writeFileSync(appHtmlPath, markedAppHtml(original, version));
		// AGENTS.md: a stale .svelte-kit or build/ produces symptoms identical to a real
		// defect, and this probe's whole output is a claim about which build is live.
		rmSync(join(repoRoot, '.svelte-kit'), { recursive: true, force: true });
		rmSync(join(repoRoot, 'build'), { recursive: true, force: true });
		execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' });
		rmSync(outDir, { recursive: true, force: true });
		cpSync(join(repoRoot, 'build'), outDir, { recursive: true });
	} finally {
		writeFileSync(appHtmlPath, original);
	}
}

const work = mkdtempSync(join(tmpdir(), 'probe-sw-'));
const dirA = join(work, 'buildA');
const dirB = join(work, 'buildB');

console.log('Building version A...');
build('A', dirA);
console.log('Building version B...');
build('B', dirB);

// Served the way tests/e2e/support/static-server.mjs serves it — plain files, sirv,
// nothing SvelteKit-shaped in front. `dev: true` only means sirv stats the file per
// request instead of caching a listing at boot, which is what lets one origin switch
// from A to B without the browser ever seeing a different host or port.
const handlers = {
	A: sirv(dirA, { dev: true, etag: true }),
	B: sirv(dirB, { dev: true, etag: true })
};
let live = 'A';

const server = createServer((req, res) => {
	handlers[live](req, res, () => {
		res.statusCode = 404;
		res.end('Not found');
	});
});
await new Promise((resolve) => server.listen(port, resolve));

const browser = await chromium.launch();
let failures = 0;

const readState = (page) =>
	page.evaluate(() => ({
		version: document.querySelector('#probe-build')?.getAttribute('data-version') ?? null,
		controlled: !!navigator.serviceWorker?.controller,
		promptVisible: /A new version of Layover is ready/i.test(document.body.innerText)
	}));

const waitForWorker = (page) =>
	page
		.evaluate(
			() =>
				new Promise((resolve) => {
					if (!('serviceWorker' in navigator)) return resolve(false);
					navigator.serviceWorker.ready.then(() => resolve(true));
					setTimeout(() => resolve(false), 10_000);
				})
		)
		.catch(() => false);

/**
 * One visitor, start to finish. Each scenario gets its own context, so each one starts
 * from a browser that has never seen this origin and installs the worker itself.
 */
async function scenario(name, deployLands) {
	console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);
	live = 'A';
	const ctx = await newProbeContext(browser);
	const page = await ctx.newPage();

	// Twice: the first visit installs the worker, the second is served by it. That is
	// the state a returning visitor is actually in.
	await page.goto(`${origin}/`, { waitUntil: 'load' });
	await waitForWorker(page);
	await page.goto(`${origin}/`, { waitUntil: 'load' });
	await waitForWorker(page);

	const before = await readState(page);
	console.log(`  on version A      : build ${before.version} | controlled by SW: ${before.controlled}`);
	if (!before.controlled) {
		console.log('  ! the worker never took control, so what follows is not a returning visit');
		failures += 1;
	}
	if (before.version !== 'A') {
		console.log(`  ! expected build A here, got ${before.version}`);
		failures += 1;
	}

	live = 'B';
	const startedAt = Date.now();
	await deployLands(page);

	let state = await readState(page).catch(() => before);
	while (Date.now() - startedAt < settleMs) {
		if (state.version === 'B') break;
		await page.waitForTimeout(250);
		state = await readState(page).catch(() => state);
	}
	const elapsed = Date.now() - startedAt;

	if (state.version === 'B') {
		console.log(`  after B deployed  : build B after ${elapsed}ms, with no interaction. PASS`);
	} else {
		console.log(
			`  after B deployed  : still build ${state.version} after ${elapsed}ms. FAIL` +
				(state.promptVisible
					? '\n                      An update prompt is on screen, so the only way out is a click.'
					: '\n                      Nothing on screen offers a way out.')
		);
		failures += 1;
	}

	if (screenshotPath) {
		await page.screenshot({ path: screenshotPath });
		console.log(`  screenshot        : ${screenshotPath}`);
		screenshotPath = undefined; // first scenario only
	}
	return { ctx, page };
}

// Scenario 1: comes back later and loads a page. The browser re-checks sw.js on every
// navigation, so this is the path that needs no help from the app at all.
const navigated = await scenario('a returning visitor loads a page', (page) =>
	page.goto(`${origin}/`, { waitUntil: 'load' })
);
await navigated.ctx.close();

// Scenario 2: never left. A tab open on results all afternoon never navigates, which is
// what src/lib/pwa/register-sw.ts's own update check is for. The event is dispatched at
// the document rather than produced by hiding the tab because Playwright reports every
// page as visible, headless or headed, so `bringToFront` fires nothing (measured).
// Everything downstream of the app's own listener — the update check, the install, the
// claim, the reload — is real.
const openTab = await scenario('a tab left open, never navigated', async (page) => {
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
});

// --- Offline. A service worker that stops serving the shell has lost its only job. ---
// The server is shut down rather than the browser being told it is offline: this probe
// may not fake a network condition (tests/e2e/guard.spec.ts forbids it, and rightly —
// an instrument that can answer a request cannot be trusted to report one). With
// nothing listening on the port, anything the precache does not cover fails for real.
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

let offline;
try {
	const response = await openTab.page.reload({ waitUntil: 'load' });
	const bodyLength = await openTab.page.evaluate(() => document.body.innerText.trim().length);
	offline = { ok: !!response?.ok(), bodyLength };
} catch (error) {
	offline = { ok: false, bodyLength: 0, error: String(error) };
}
console.log(
	`\n── offline, server shut down ──────────────────────────────────\n` +
		`  reload            : response ok ${offline.ok} | ${offline.bodyLength} chars of shell rendered`
);
if (!offline.ok || offline.bodyLength === 0) {
	console.log(`  ! the shell did not come up offline${offline.error ? `: ${offline.error}` : ''}`);
	failures += 1;
}

await browser.close();
rmSync(work, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
