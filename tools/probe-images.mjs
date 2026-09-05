/**
 * Measures whether a provider's image URLs actually render in a visitor's browser.
 *
 * `probe-cors.mjs` answers a different question. It runs `fetch()`, so it measures
 * `Access-Control-Allow-Origin`. An `<img>` tag is a no-cors request and ignores that
 * header entirely, so a host with no CORS at all can still serve pictures fine. What
 * stops an `<img>` is `Cross-Origin-Resource-Policy: same-origin`, or a hotlink rule
 * that reads `Referer` and answers 403 or a placeholder. curl shows neither, because
 * curl sends no `Referer` and no `Sec-Fetch-*`, and enforces no CORP.
 *
 * So this serves a page from a real http:// origin, points `<img>` tags at the URLs,
 * and reports `naturalWidth`. A decoded pixel is the only proof that the app's carousel
 * will show something.
 *
 * Usage: node probe-images.mjs urls.json
 * urls.json: [{ name, url }]
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const targets = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.env.PROBE_PORT ?? 8791);

const page_html = `<!doctype html><title>image probe</title><body></body>`;
const server = createServer((_req, res) => {
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end(page_html);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
// Same reason probe-cors.mjs overrides it: "HeadlessChrome" gets different answers from
// some hosts than a real Chrome does, and the question is what a real visitor sees.
const REAL_CHROME_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const context = await browser.newContext({ userAgent: REAL_CHROME_UA });
const page = await context.newPage();

const wire = new Map();
page.on('response', (r) => {
	if (r.url().startsWith(ORIGIN)) return;
	wire.set(r.url(), { status: r.status(), headers: r.headers() });
});
const failed = new Map();
page.on('requestfailed', (r) => {
	if (r.url().startsWith(ORIGIN)) return;
	failed.set(r.url(), r.failure()?.errorText);
});

await page.goto(ORIGIN);

const results = [];
for (const { name, url } of targets) {
	const decoded = await page.evaluate(
		([src]) =>
			new Promise((resolve) => {
				const img = new Image();
				img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
				img.onerror = () => resolve({ ok: false, w: 0, h: 0 });
				img.src = src;
				setTimeout(() => resolve({ ok: false, w: 0, h: 0, timeout: true }), 12000);
			}),
		[url]
	);
	const seen = wire.get(url);
	results.push({
		name,
		url,
		decoded,
		status: seen?.status,
		corp: seen?.headers['cross-origin-resource-policy'],
		acao: seen?.headers['access-control-allow-origin'],
		type: seen?.headers['content-type'],
		bytes: seen?.headers['content-length'],
		netError: failed.get(url)
	});
}

for (const r of results) {
	const verdict = r.decoded.ok ? `RENDERS ${r.decoded.w}x${r.decoded.h}` : 'BLANK';
	console.log(
		`${verdict.padEnd(20)} ${r.name}\n  status=${r.status} type=${r.type} bytes=${r.bytes} corp=${r.corp ?? '-'} acao=${r.acao ?? '-'}${r.netError ? ` neterr=${r.netError}` : ''}\n  ${r.url}`
	);
}

await browser.close();
server.close();
