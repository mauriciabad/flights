/**
 * Loads a results URL in its own Chromium and reports what the page says plus what the
 * network actually did. The request log is usually the half the screen leaves out.
 *
 *   node tools/probe-results.mjs 'https://flights.mauri.app/results/?...'
 *
 * Before it reports anything it checks whether it was shown fixture data. On 2026-09-04
 * an agent reported "1 itinerary, BVC -> LGW -> PFO, EUR 238.00, via Ryanair, with zero
 * keys configured" and was reading Playwright route handlers that a different agent had
 * left armed in the shared MCP browser half an hour earlier. Ryanair does not serve BVC.
 * Every mock in this repo now carries a marker from tests/e2e/fixtures/markers.json, and
 * finding one here means the measurement is worthless — so this prints that, instead of a
 * count somebody could quote.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8'));
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const url = process.argv[2];
const waitMs = Number(process.argv[3] ?? 90000);
const appOrigin = new URL(url).origin;

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const responses = [];
const failed = [];
// Provider response bodies, kept so the fixture check has something authoritative to read.
// A mocked payload names a FIXTURE airport or carries an impossible flight number even
// when the rendered card shows neither, because a results card only ever shows IATA
// codes, a total and a duration.
const providerBodies = [];
const bodyReads = [];
page.on('response', (r) => {
	const u = r.url();
	if (u.startsWith(appOrigin) || u.includes('flights.mauri.app') || u.startsWith('data:')) return;
	responses.push({ status: r.status(), url: u });
	if (!/^https?:/.test(u)) return;
	bodyReads.push(
		r
			.text()
			.then((body) => providerBodies.push({ url: u, body: body.slice(0, 20000) }))
			.catch(() => {})
	);
});
page.on('requestfailed', (r) => failed.push({ url: r.url().slice(0, 130), err: r.failure()?.errorText }));
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 250)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 400)));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
const deadline = Date.now() + waitMs;
let text = '';
while (Date.now() < deadline) {
	text = await page.evaluate(() => document.body.innerText);
	if (!/still searching/.test(text)) break;
	await page.waitForTimeout(2000);
}

// Response bodies arrive asynchronously; give the outstanding reads a moment to land so
// the check below sees the whole network log rather than whichever half finished first.
await Promise.race([
	Promise.allSettled(bodyReads),
	new Promise((resolve) => setTimeout(resolve, 5000).unref())
]);

/** Every place a marker turned up, as `where -> token` lines. Empty means the page was
 * served by whatever is really behind that URL. */
function findFixtureLeaks() {
	const hits = [];
	for (const token of FIXTURE_TOKENS) {
		if (text.includes(token)) hits.push(`rendered page text -> ${token}`);
		for (const { url: responseUrl, body } of providerBodies) {
			if (body.includes(token)) hits.push(`${new URL(responseUrl).host} response body -> ${token}`);
		}
	}
	return [...new Set(hits)];
}

const leaks = findFixtureLeaks();
if (leaks.length) {
	console.log('!!! MEASUREMENT INVALID: this page was served fixture data, not provider data.');
	console.log('!!! Markers found (tests/e2e/fixtures/markers.json):');
	for (const hit of leaks.slice(0, 12)) console.log('!!!   ' + hit);
	console.log('!!!');
	console.log('!!! Nothing on this page is evidence about production. A route handler is');
	console.log('!!! answering provider hostnames with a mock — almost certainly one left armed');
	console.log('!!! in a shared Playwright browser (AGENTS.md, "Mocks belong to a test"), or a');
	console.log('!!! proxy in front of this process. Find it, clear it, and measure again.');
	console.log('!!! Deliberately NOT reporting an itinerary count: a count from a mock is the');
	console.log('!!! exact false result this check exists to stop (docs/ACCEPTANCE.md).');
	console.log('--- what the network did ---\n' + JSON.stringify(hostSummary(responses), null, 1));
	await browser.close();
	process.exit(1);
}

console.log('COUNT:', (text.match(/\d+ of \d+ itiner\w+/) || ['(none)'])[0], '| stillSearching:', /still searching/.test(text));
const i = text.indexOf('PROVIDERS THAT ANSWERED');
console.log('--- what the page says ---\n' + (i >= 0 ? text.slice(i, i + 600) : text.slice(0, 600)));
console.log('--- what the network did ---\n' + JSON.stringify(hostSummary(responses), null, 1));
console.log('--- non-2xx samples ---\n' + responses.filter((r) => r.status >= 400).slice(0, 6).map((b) => `${b.status} ${b.url.slice(0, 110)}`).join('\n'));
if (failed.length) console.log('--- blocked/failed ---\n' + JSON.stringify(failed.slice(0, 8), null, 1));
if (errors.length) console.log('--- console errors ---\n' + [...new Set(errors)].slice(0, 8).join('\n'));
await browser.close();

function hostSummary(seen) {
	const byHost = {};
	for (const r of seen) { const h = new URL(r.url).host; byHost[h] ??= {}; byHost[h][r.status] = (byHost[h][r.status] ?? 0) + 1; }
	return byHost;
}
