/**
 * The before picture for the owner's 2026-09-06 review: the stay row's facts, and how many
 * ground-leg previews are a solid grey box rather than a coast.
 *
 * Own Chromium, never the shared MCP browser. Aborts on any fixture marker, because a
 * number read off another agent's route handler is worse than no number.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { newProbeContext } from '../tools/probe-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8'));
const TOKENS = [markers.textToken, ...markers.flightNumbers];

const url =
	process.argv[2] ??
	'https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(60000);

const body = await page.evaluate(() => document.body.innerText);
const leaked = TOKENS.filter((t) => body.includes(t));
if (leaked.length) {
	console.log(`MEASUREMENT INVALID: fixture marker in page: ${leaked.join(', ')}`);
	await browser.close();
	process.exit(1);
}

const shot = (name) => page.screenshot({ path: path.join(here, `baseline-${name}.png`), fullPage: false });

// A full-box fill is four corners and a close. A real coast is anything else.
const land = await page.evaluate(() => {
	const paths = [...document.querySelectorAll('.rp-land')];
	const isWholeBox = (d) => /^M0 0L[\d.]+ 0L[\d.]+ [\d.]+L0 [\d.]+Z$/.test(d ?? '');
	return {
		total: paths.length,
		solid: paths.filter((p) => isWholeBox(p.getAttribute('d'))).length,
		samples: paths.slice(0, 3).map((p) => (p.getAttribute('d') ?? '').slice(0, 70))
	};
});

const cards = await page.evaluate(() => document.querySelectorAll('[data-testid="result-card"], article').length);
await shot('results');

// Open the first itinerary, then the stopover, by accessible name rather than by a class
// the design keeps changing.
const openedDetail = await page
	.getByRole('button', { name: /show the full timeline/i })
	.first()
	.click({ timeout: 8000 })
	.then(() => true)
	.catch(() => false);
await page.waitForTimeout(4000);
await shot('detail');

const groundLegs = await page.evaluate(() => {
	const paths = [...document.querySelectorAll('.ground-leg .rp-land')];
	const isWholeBox = (d) => /^M0 0L[\d.]+ 0L[\d.]+ [\d.]+L0 [\d.]+Z$/.test(d ?? '');
	return {
		total: paths.length,
		solid: paths.filter((p) => isWholeBox(p.getAttribute('d'))).length,
		legLabels: [...document.querySelectorAll('.ground-leg')].map((b) => b.innerText.replace(/\s+/g, ' ').trim())
	};
});

const openedStopover = await page
	.getByRole('button', { name: /^Stopover,/i })
	.first()
	.click({ timeout: 8000 })
	.then(() => true)
	.catch(() => false);
await page.waitForTimeout(6000);

const buttons = await page.evaluate(() =>
	[...document.querySelectorAll('button')].map((b) => (b.innerText || b.ariaLabel || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 60)
);

const stayRows = await page.evaluate(() =>
	[...document.querySelectorAll('.alt-card')].map((c) => c.innerText.replace(/\n+/g, ' | ').trim())
);
await shot('after-open');

const out = {
	url,
	when: new Date().toISOString(),
	cards,
	openedDetail,
	openedStopover,
	land,
	groundLegs,
	stayRowCount: stayRows.length,
	stayRows: stayRows.slice(0, 8),
	buttons,
	consoleErrors: consoleErrors.slice(0, 10)
};
writeFileSync(path.join(here, 'baseline-owner-review.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
