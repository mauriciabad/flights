/**
 * What the frozen previews cost to render, using the real component (issue #408).
 *
 *   node tools/probe-preview-cost.mjs            # 1, 3 and 5 cards
 *   node tools/probe-preview-cost.mjs 5          # just 5 cards
 *
 * `tools/probe-map-cost.mjs` answered "SVG or MapLibre" and its verdict stands: four
 * MapLibre instances per card settle in 4.5 s and twenty never settle at all. It cannot
 * answer this question, because it draws its own SVG by hand and never runs a line of this
 * app's code. This one mounts `RoutePreview` itself, so `land.ts`, `land-tiles.svelte.ts`
 * and the generated data are all in the measurement.
 *
 * Two numbers come out, and they mean different things:
 *
 *   painted   ms to the frame after the previews are on screen. This is the figure
 *             `RoutePreview`'s header claims ("ready in about 100ms at any card count")
 *             and the one that must not regress.
 *   settled   ms until the picture stops changing, which is when the fetched regional
 *             tiles have landed and the ground legs have redrawn with their real coasts.
 *             New in #408, and it is deliberately not on the critical path: the honest
 *             solid fill is up at `painted`.
 *
 * `solid` counts previews still filling their whole box, which is how a run can tell a
 * fast render from a render that quietly gave up.
 *
 * Launches its own Chromium, never the shared MCP browser (AGENTS.md).
 */
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
// The checkout whose `src/` and `static/` are under test. `PREVIEW_COST_SRC` points it at
// another one, which is how the before-and-after in #408's PR was measured: same harness,
// same probe, different app.
const repo = process.env.PREVIEW_COST_SRC ?? path.join(here, '..');
const harness = path.join(here, 'preview-cost');
const dist = path.join(harness, 'dist');

const onlyCards = process.argv[2] ? Number(process.argv[2]) : undefined;
const CARD_COUNTS = onlyCards ? [onlyCards] : [1, 3, 5];
const PORT = Number(process.env.PREVIEW_COST_PORT ?? 41881);
// Two, matching probe-map-cost.mjs, so a phone's main thread is what is being measured
// rather than a laptop's.
const CPU_THROTTLE = Number(process.env.PREVIEW_COST_THROTTLE ?? 2);
const RUNS = Number(process.env.PREVIEW_COST_RUNS ?? 5);

if (!process.env.PREVIEW_COST_SKIP_BUILD) {
	const built = spawnSync(
		'pnpm',
		['exec', 'vite', 'build', '--config', path.join(harness, 'vite.config.mjs')],
		{ cwd: repo, stdio: 'inherit' }
	);
	if (built.status !== 0) throw new Error('the harness did not build');
}
if (!existsSync(path.join(dist, 'index.html'))) throw new Error(`no harness build in ${dist}`);

const TYPES = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.txt': 'text/plain',
	'.json': 'application/json'
};

// The land tiles are served straight out of static/, exactly as the built app serves them.
const server = http.createServer((request, response) => {
	const { pathname } = new URL(request.url, 'http://localhost');
	const file = pathname.startsWith('/land/')
		? path.join(repo, 'static', pathname)
		: path.join(dist, pathname === '/' ? 'index.html' : pathname);
	try {
		if (!statSync(file).isFile()) throw new Error('not a file');
		response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
		response.end(readFileSync(file));
	} catch {
		response.writeHead(404).end('not found');
	}
});
await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch();
const rows = [];
for (const cards of CARD_COUNTS) {
	const painted = [];
	const settled = [];
	let census = {};
	let tileRequests = 0;
	let tileBytes = 0;
	for (let run = 0; run < RUNS; run++) {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		const page = await context.newPage();
		page.on('response', async (response) => {
			if (!response.url().includes('/land/')) return;
			tileRequests += 1;
			try {
				tileBytes += (await response.body()).length;
			} catch {
				// A body that has gone by the time it is asked for costs the byte count and
				// nothing else; the request count is the number this is really after.
			}
		});
		const session = await context.newCDPSession(page);
		await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

		await page.goto(`http://localhost:${PORT}/?cards=${cards}`, { waitUntil: 'load' });
		await page.waitForFunction('window.__previewCost?.settledMs !== undefined', null, { timeout: 30000 });
		const result = await page.evaluate('window.__previewCost');
		painted.push(result.paintedMs);
		settled.push(result.settledMs);
		census = result;
		await context.close();
	}
	const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
	rows.push({
		cards,
		previews: cards * 4,
		paintedMs: median(painted),
		settledMs: median(settled),
		landPaths: census.landPaths,
		borderPaths: census.borderPaths,
		solid: census.solidBoxes,
		tileRequests: Math.round(tileRequests / RUNS),
		tileBytes: Math.round(tileBytes / RUNS)
	});
}
await browser.close();
server.close();

const header = [
	'cards',
	'previews',
	'paintedMs',
	'settledMs',
	'landPaths',
	'borderPaths',
	'solid',
	'tileRequests',
	'tileBytes'
];
console.log(`cpu throttle ${CPU_THROTTLE}x, median of ${RUNS} runs`);
console.log(header.join('\t'));
for (const row of rows) console.log(header.map((key) => row[key]).join('\t'));
