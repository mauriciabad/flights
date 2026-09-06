/**
 * How many ground legs draw a real route, how many still draw a dash, and what one search
 * cost to find out.
 *
 *   node tools/probe-transit-geometry.mjs 'https://flights.mauri.app/results/?...'
 *   node tools/probe-transit-geometry.mjs 'http://localhost:4416/results/?...' --profile /tmp/x
 *
 * Issue #416 is the reason it exists. `probe-ground-legs.mjs` reports each leg's MODE; this
 * one reports each leg's SHAPE, which is a different fact and the one that was wrong: a
 * transit transfer drew a dashed straight line while the route it takes sat unread in the
 * response the app had already received. The pairing that makes the reading worth anything
 * is the two halves printed together — the routed/schematic split beside the request count,
 * because "the map got better" is only interesting if it cost nothing.
 *
 * `--profile <dir>` keeps a persistent browser profile, so a second run reuses the first
 * run's IndexedDB. That is the whole point of it: the response cache is in IndexedDB, a
 * fresh Chromium never has one, and a cached value whose shape changed is the class of bug
 * that only a returning visitor ever sees (AGENTS.md, the #131 note). Point two builds at
 * the same port with the same profile and this prints what the traveller who used the app
 * last week will actually get.
 *
 * Carries `probe-results.mjs`'s fixture-marker guard, because a shape read off a mocked
 * page is worth nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { PROBE_USER_AGENT } from './probe-browser.mjs';

const repo = new URL('..', import.meta.url).pathname;
const markers = JSON.parse(
	readFileSync(path.join(repo, 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const profileIndex = args.indexOf('--profile');
const profile = profileIndex === -1 ? undefined : args[profileIndex + 1];
if (!url) {
	console.error('usage: node tools/probe-transit-geometry.mjs <results url> [--profile <dir>]');
	process.exit(2);
}
const appOrigin = new URL(url).origin;

const context = profile
	? await chromium.launchPersistentContext(profile, { userAgent: PROBE_USER_AGENT })
	: await (await chromium.launch()).newContext({ userAgent: PROBE_USER_AGENT });
const page = await context.newPage();

const responses = [];
const providerBodies = [];
const bodyReads = [];
page.on('response', (r) => {
	const u = r.url();
	if (u.startsWith(appOrigin) || u.startsWith('data:')) return;
	responses.push({ status: r.status(), url: u });
	if (!/^https?:/.test(u)) return;
	bodyReads.push(
		r
			.text()
			.then((body) => providerBodies.push({ url: u, body: body.slice(0, 20000) }))
			.catch(() => {})
	);
});
const errors = [];
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page
	.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 })
	.catch(() => {});
const deadline = Date.now() + 120000;
let text = '';
while (Date.now() < deadline) {
	text = await page.evaluate(() => document.body.innerText);
	if (!/still searching/.test(text)) break;
	await page.waitForTimeout(2000);
}
await Promise.race([
	Promise.allSettled(bodyReads),
	new Promise((resolve) => setTimeout(resolve, 5000).unref())
]);

const leaks = [];
for (const token of FIXTURE_TOKENS) {
	if (text.includes(token)) leaks.push(`rendered page -> ${token}`);
	for (const { url: u, body } of providerBodies) {
		if (body.includes(token)) leaks.push(`${new URL(u).host} -> ${token}`);
	}
}
if (leaks.length) {
	console.log('!!! MEASUREMENT INVALID, fixture markers found:');
	for (const hit of [...new Set(leaks)].slice(0, 12)) console.log('!!!  ' + hit);
	await context.close();
	process.exit(1);
}

console.log('COUNT:', (text.match(/\d+ of \d+ itiner\w+/) || ['(none)'])[0]);

// The same control `tests/e2e/support/results-ui.ts` presses, so this tool and the suite
// open the panel the same way rather than each holding its own guess at the selector.
const unfold = page.locator('.result-card .trip-strip-unfold').first();
if ((await unfold.count()) === 0) {
	console.log('no card to open — nothing to measure');
	await context.close();
	process.exit(1);
}
await unfold.click();
// Waited for rather than slept past: a warm cache paints the panel in well under a second
// and a cold one can take several, and a fixed sleep reads "no previews" as "no legs".
await page
	.locator('.result-detail .ground-legs-item')
	.first()
	.waitFor({ state: 'visible', timeout: 30000 })
	.catch(() => {});
await page.waitForTimeout(2000);

const previews = await page.evaluate(() =>
	[...document.querySelectorAll('.result-detail .ground-legs-item')].map((item) => {
		const paths = [...item.querySelectorAll('svg path.rp-leg')];
		return {
			label: item.querySelector('.ground-leg-label')?.textContent?.trim() ?? '(unlabelled)',
			name: item.querySelector('.ground-leg')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
			// A schematic hop is one straight line, so its `d` holds a single `L`. A routed
			// leg holds one per bend, which is what tells a real shape from a two-point hop
			// that merely lost its dash.
			legs: paths.map((p) => ({
				schematic: p.classList.contains('is-estimate'),
				segments: (p.getAttribute('d') ?? '').split('L').length - 1
			}))
		};
	})
);

let routed = 0;
let schematic = 0;
console.log('\n--- ground-leg previews ---');
for (const preview of previews) {
	for (const leg of preview.legs) {
		if (leg.schematic) schematic += 1;
		else routed += 1;
	}
	const shape = preview.legs
		.map((leg) => `${leg.schematic ? 'schematic' : 'routed'}(${leg.segments})`)
		.join(' ');
	console.log(`${preview.label}: ${shape || '(no line)'}`);
	console.log(`  ${preview.name}`);
}
console.log(`\nroutedLegs ${routed} schematicLegs ${schematic}`);

console.log('\n--- requests, by host ---');
const byHost = {};
for (const r of responses) {
	const h = new URL(r.url).host;
	byHost[h] ??= { total: 0 };
	byHost[h].total += 1;
	byHost[h][r.status] = (byHost[h][r.status] ?? 0) + 1;
}
console.log(JSON.stringify(byHost, null, 1));
const plans = responses.filter((r) => r.url.includes('api.transitous.org/api/v1/plan')).length;
console.log(`transitousPlanRequests ${plans}`);

if (errors.length) console.log('\n--- console errors ---\n' + [...new Set(errors)].slice(0, 8).join('\n'));
await context.close();
