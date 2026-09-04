/**
 * Measures whether an endpoint is callable from a real browser page origin.
 *
 * curl cannot answer this: it never runs the preflight and never enforces the
 * response's Access-Control-Allow-Origin. So this serves a page from a real
 * http:// origin, navigates its own Chromium there, and runs fetch() from that
 * document. What the page sees is what the app would see.
 *
 * It records BOTH sides:
 *   - what the page observed (fetch resolved, or the TypeError the browser threw)
 *   - what the wire actually carried (page.on('response') sees every header,
 *     including ones CORS would hide from script)
 *
 * Usage: node probe-cors.mjs probes.json
 * probes.json: [{ name, url, init? }]
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const probes = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.env.PROBE_PORT ?? 8788);

const server = createServer((_req, res) => {
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end('<!doctype html><title>cors probe</title><body>probe origin</body>');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
// Playwright's default headless UA says "HeadlessChrome", and at least one host
// (api.skypicker.com) answers that UA with a 403 carrying no CORS headers at all
// while giving a normal Chrome UA a 200 with `Access-Control-Allow-Origin: *`.
// Measuring with the default UA therefore reports "no CORS" for an endpoint a real
// visitor's browser can call fine — the opposite of the mistake this tool exists to
// prevent. PROBE_UA=default opts back out when you want to see the raw behaviour.
const REAL_CHROME_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const context = await browser.newContext(
	process.env.PROBE_UA === 'default' ? {} : { userAgent: process.env.PROBE_UA ?? REAL_CHROME_UA }
);
const page = await context.newPage();

/** Real wire headers, keyed by url, captured outside the CORS sandbox. */
const wire = new Map();
page.on('response', (r) => {
	if (r.url().startsWith(ORIGIN)) return;
	wire.set(r.url(), { status: r.status(), headers: r.headers(), method: r.request().method() });
});
const failed = [];
page.on('requestfailed', (r) => {
	if (r.url().startsWith(ORIGIN)) return;
	failed.push({ url: r.url(), method: r.method(), err: r.failure()?.errorText });
});
const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text());
});

await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });

for (const probe of probes) {
	wire.clear();
	failed.length = 0;
	consoleErrors.length = 0;

	const observed = await page.evaluate(async ({ url, init }) => {
		const started = Date.now();
		try {
			const res = await fetch(url, { ...(init ?? {}) });
			const text = await res.text();
			const visible = {};
			res.headers.forEach((v, k) => (visible[k] = v));
			return {
				threw: false,
				status: res.status,
				statusText: res.statusText,
				type: res.type,
				scriptVisibleHeaders: visible,
				bodyLength: text.length,
				body: text.slice(0, 1400),
				ms: Date.now() - started
			};
		} catch (e) {
			return { threw: true, error: String(e), ms: Date.now() - started };
		}
	}, probe);

	const wireRows = [...wire.entries()].map(([url, r]) => ({
		url: url.slice(0, 180),
		method: r.method,
		status: r.status,
		acao: r.headers['access-control-allow-origin'] ?? null,
		acah: r.headers['access-control-allow-headers'] ?? null,
		acam: r.headers['access-control-allow-methods'] ?? null,
		acac: r.headers['access-control-allow-credentials'] ?? null
	}));

	console.log(
		JSON.stringify(
			{
				probe: probe.name,
				url: probe.url,
				pageOrigin: ORIGIN,
				observed,
				wire: wireRows,
				requestFailed: failed.map((f) => ({ ...f, url: f.url.slice(0, 180) })),
				consoleErrors: consoleErrors.slice(0, 4)
			},
			null,
			1
		)
	);
	console.log('================================================================');
}

await browser.close();
server.close();
