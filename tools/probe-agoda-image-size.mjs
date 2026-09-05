/**
 * Proves that the size `agoda-photo.ts` asks for is a size Agoda actually serves, that it
 * still covers the box the card draws, and what it saves.
 *
 * A type-check cannot answer any of that. `s=800x600` is a string until a CDN reads it, so
 * this renders real `<img>` tags from an http:// origin and reads `naturalWidth` back. An
 * `<img>` is a no-cors request, so a `fetch()` here would measure headers a picture
 * ignores. Every URL comes from the Agoda search fixture the unit tests use, run through
 * the same `agodaCardPhoto` the mapper calls.
 *
 * The floor is 766, the widest the card's media box was measured at in the built app
 * (`StayPicker.svelte`'s `.stay-open-media`, at the 1280 and 1600 viewports where the
 * page's 72rem max width caps it; 269 at 375 and 662 at 768). That box is `object-fit:
 * cover` at 16/9 and Agoda's photographs are all taller than that, so cover matches the
 * box's width. A delivered width under the floor is a visible upscale, and fails this run.
 *
 * Exits non-zero when a rewritten URL fails to render, comes back narrower than the floor,
 * or is not smaller than what Agoda stored.
 *
 * Usage: node tools/probe-agoda-image-size.mjs
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agodaCardPhoto } from '../src/lib/providers/stays/agoda-photo.ts';

const FIXTURE = fileURLToPath(
	new URL('../src/lib/providers/stays/fixtures/agoda-search-vienna.json', import.meta.url)
);
const CARD_BOX_WIDTH = 766;
const PORT = Number(process.env.PROBE_PORT ?? 8791);

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const stored = [];
for (const property of fixture.data?.properties ?? []) {
	for (const image of property.content?.images?.hotelImages ?? []) {
		const value = image.urls?.find((u) => u.key === 'original')?.value;
		if (typeof value === 'string' && value.trim())
			stored.push(value.startsWith('//') ? `https:${value.trim()}` : value.trim());
	}
}
if (stored.length === 0) {
	console.error('The fixture holds no images. Nothing to measure.');
	process.exit(1);
}

const server = createServer((_req, res) => {
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end('<!doctype html><title>agoda image size</title><body></body>');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
// Same override probe-cors.mjs uses: "HeadlessChrome" gets different answers from some
// hosts than a real Chrome does, and the question is what a real visitor sees.
const context = await browser.newContext({
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
});
const page = await context.newPage();
const wire = new Map();
page.on('response', (r) => {
	if (!r.url().startsWith(ORIGIN)) wire.set(r.url(), Number(r.headers()['content-length'] ?? 0));
});
await page.goto(ORIGIN);

async function render(url) {
	const decoded = await page.evaluate(
		([src]) =>
			new Promise((resolve) => {
				const img = new Image();
				img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
				img.onerror = () => resolve({ ok: false, w: 0, h: 0 });
				img.src = src;
				setTimeout(() => resolve({ ok: false, w: 0, h: 0 }), 15000);
			}),
		[url]
	);
	return { ...decoded, bytes: wire.get(url) ?? 0 };
}

let failures = 0;
let rewritten = 0;
let storedBytes = 0;
let cardBytes = 0;
for (const url of stored) {
	const cardUrl = agodaCardPhoto(url);
	if (cardUrl === url) {
		// Agoda's search response mixes in photographs hosted by Booking (`bstatic.com`),
		// already served at `max500`. The host guard leaves them alone and so does this
		// check: judging a URL this rewrite never claimed would report a defect that isn't.
		const seen = await render(url);
		console.log(`SKIP ${seen.w}x${seen.h} ${seen.bytes} B, another host's\n     ${url}`);
		continue;
	}

	const before = await render(url);
	const after = await render(cardUrl);
	rewritten += 1;
	storedBytes += before.bytes;
	cardBytes += after.bytes;

	const problems = [];
	if (!after.ok) problems.push('did not render');
	if (after.w < CARD_BOX_WIDTH) problems.push(`${after.w}px is narrower than the ${CARD_BOX_WIDTH}px box`);
	if (after.bytes >= before.bytes) problems.push('no smaller than what Agoda stored');
	if (problems.length > 0) failures += 1;

	console.log(
		`${problems.length === 0 ? 'OK  ' : 'FAIL'} ${before.w}x${before.h} ${before.bytes} B  ->  ${after.w}x${after.h} ${after.bytes} B` +
			`${problems.length > 0 ? `\n     ${problems.join('; ')}` : ''}\n     ${url}`
	);
}

console.log(
	`\n${rewritten} Agoda photographs: ${storedBytes} B stored, ${cardBytes} B at the card size ` +
		`(${(100 - (cardBytes / storedBytes) * 100).toFixed(1)}% less, ${(storedBytes / cardBytes).toFixed(1)}x).`
);

await browser.close();
server.close();
process.exit(failures > 0 ? 1 : 0);
