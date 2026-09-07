/**
 * Presses the heart on a real results page, reloads twice, and reports what the price log
 * did. Also measures and photographs the card header at both widths in both schemes.
 *
 * Issues #434 and #437. The claim this exists to check cannot be checked any other way: the
 * owner asked for "a new price entry only when the user revisits the page", and a revisit is
 * a whole page load. A unit test can prove `appendObservation` refuses a repeated token; only
 * a browser can prove the results page mints one token per visit and hands the same one to
 * the heart.
 *
 *   node tests/e2e/support/static-server.mjs build 4897
 *   node tools/probe-heart.mjs http://localhost:4897 [outputDir]
 *
 * It runs a live search against Ryanair, which is free (AGENTS.md, "The owner's quota"), and
 * it refuses to report anything if a fixture marker turns up in the page, for the reason
 * `tools/probe-results.mjs` gives at length. Its own Chromium, closed at the end, because the
 * shared Playwright MCP browser carries other agents' tabs and route handlers.
 *
 * Exits non-zero when the log did not grow by exactly one row per visit.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(
	readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const origin = process.argv[2] ?? 'http://localhost:4897';
const outDir = process.argv[3] ?? '.';
mkdirSync(outDir, { recursive: true });

const STORAGE_KEY = 'flights.savedItineraries.v1';
const URL = `${origin}/results/?arr=2026-10-12&dep=2026-10-06&from=BCN&to=PFO`;
/** Ryanair answers a headless Chrome UA differently from a browser's own, and Kiwi's public
 * endpoint 403s it outright. Same string `probe-results.mjs` sends, for the same reason. */
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const browser = await chromium.launch();
const problems = [];

async function settled(page) {
	await page.locator('.result-card').first().waitFor({ timeout: 90_000 });
	await page.waitForFunction(
		() =>
			document.querySelector('[data-search-phase]')?.getAttribute('data-search-phase') ===
			'settled',
		null,
		{ timeout: 120_000 }
	);
}

function readStore(page) {
	return page.evaluate((key) => {
		const raw = localStorage.getItem(key);
		if (!raw) return [];
		return JSON.parse(raw).map((entry) => ({
			id: entry.id,
			savedAt: entry.savedAt,
			visits: entry.prices.map((price) => price.visit),
			totals: entry.prices.map((price) => `${price.total.currency} ${price.total.minorUnits}`)
		}));
	}, STORAGE_KEY);
}

/** The header, block by block, so a regression in what it costs is a number and not an
 * impression. `card-size.spec.ts` budgets `card-header` at 90px on a 375px phone. */
function measureHeader(page) {
	return page.evaluate(() =>
		[...document.querySelectorAll('.result-card')].map((card) => {
			const route = card.querySelector('.route');
			const stamp = route.querySelector('.route-dates');
			// By centre, not by top: the items on one line are 20px, 24px and 25px tall and
			// centred against each other, so their top edges differ by a few pixels inside
			// what is plainly one row.
			const centre = (node) => {
				const box = node.getBoundingClientRect();
				return box.top + box.height / 2;
			};
			const sameRow = (a, b) => Math.abs(centre(a) - centre(b)) < 8;
			const rows = [];
			for (const item of route.children) {
				if (!rows.some((row) => sameRow(row, item))) rows.push(item);
			}
			return {
				via: card.querySelector('.route-leg-stopover .city')?.textContent.trim(),
				header: Math.round(card.querySelector('.card-header').getBoundingClientRect().height),
				card: Math.round(card.getBoundingClientRect().height),
				routeRows: rows.length,
				stampWidth: stamp ? Math.round(stamp.getBoundingClientRect().width) : null,
				/* Something has to be beside the stamp: dates alone on a line of their own is
				   the one arrangement #437 asked us not to produce. */
				stampAlone: stamp
					? [...route.children].every((item) => item === stamp || !sameRow(item, stamp))
					: false
			};
		})
	);
}

const context = await browser.newContext({
	colorScheme: 'dark',
	userAgent: USER_AGENT,
	viewport: { width: 375, height: 900 }
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
	if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await settled(page);

const rendered = await page.evaluate(() => document.body.innerText);
const leaked = FIXTURE_TOKENS.filter((token) => rendered.includes(token));
if (leaked.length > 0) {
	console.error(`MEASUREMENT INVALID: fixture markers on screen -> ${leaked.join(', ')}`);
	await browser.close();
	process.exit(2);
}

const before = await readStore(page);
const heart = page.locator('.result-card .save-trip').first();
const labelBefore = await heart.getAttribute('aria-label');
await heart.click();
const labelAfter = await heart.getAttribute('aria-label');
const afterPress = await readStore(page);

await page.reload({ waitUntil: 'domcontentloaded' });
await settled(page);
const afterFirstReturn = await readStore(page);

await page.reload({ waitUntil: 'domcontentloaded' });
await settled(page);
const afterSecondReturn = await readStore(page);

const counts = [afterPress, afterFirstReturn, afterSecondReturn].map(
	(state) => state[0]?.visits.length ?? 0
);
if (counts.join() !== '1,2,3') {
	problems.push(`expected 1, 2 then 3 price rows across three visits, got ${counts.join(', ')}`);
}
const tokens = afterSecondReturn[0]?.visits ?? [];
if (new Set(tokens).size !== tokens.length) {
	problems.push(`two rows share a visit token: ${tokens.join(', ')}`);
}
if (labelBefore === labelAfter) {
	problems.push(`the heart is called "${labelBefore}" in both states`);
}

const headerAt375 = await measureHeader(page);
if (headerAt375.some((card) => card.stampAlone)) {
	problems.push('the date stamp is alone on its line at 375px');
}
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
const headerAt1440 = await measureHeader(page);

const shots = [];
for (const scheme of ['dark', 'light']) {
	await page.emulateMedia({ colorScheme: scheme });
	for (const width of [375, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await page.waitForTimeout(400);
		await page.locator('.result-card').first().scrollIntoViewIfNeeded();
		const file = path.join(outDir, `heart-header-${scheme}-${width}.png`);
		await page.locator('.result-card').first().screenshot({ path: file });
		shots.push(file);
	}
}

await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
await browser.close();

console.log(
	JSON.stringify(
		{
			before,
			afterPress,
			afterFirstReturn,
			afterSecondReturn,
			labels: { before: labelBefore, after: labelAfter },
			headerAt375,
			headerAt1440,
			shots,
			consoleErrors,
			problems
		},
		null,
		2
	)
);
if (problems.length > 0) process.exit(1);
