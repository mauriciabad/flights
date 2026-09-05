/**
 * Prints which stopover cities a results URL actually produced, not just how many
 * itineraries it produced.
 *
 *   node tools/probe-connection-cities.mjs '<results url>' ['<another url>' ...]
 *
 * A count is not enough to see the defect this exists for. Issue #255 lost Manchester and
 * Birmingham off the acceptance route while the itinerary count stayed a plausible number,
 * and two unrelated date windows came back with the identical pair of cities — which is
 * what says "structural cap" rather than "no fares that week". So this reports the set,
 * and takes more than one URL so the comparison is one run rather than two.
 *
 * Each URL gets its own browser context, and IndexedDB is cleared before the search runs:
 * the response cache lives there (AGENTS.md) and a warm cache would hide exactly the
 * candidate fan-out this measures.
 *
 * Like tools/probe-results.mjs, it refuses to report anything if it finds a fixture marker
 * in the page or in a provider response, because a city list read off somebody's leftover
 * route handler is worse than no measurement (docs/ACCEPTANCE.md).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(
	readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const settleMs = Number(process.env.PROBE_SETTLE_MS ?? 120000);
if (urls.length === 0) {
	console.error('usage: node tools/probe-connection-cities.mjs <results-url> [<results-url> ...]');
	process.exit(2);
}

const browser = await chromium.launch();
let invalid = false;

for (const url of urls) {
	const appOrigin = new URL(url).origin;
	const context = await browser.newContext({
		// Playwright's default headless UA says "HeadlessChrome", and Kiwi's public endpoint
		// answers that with a 403 carrying no CORS headers. Probing with the default shows a
		// provider failing for a reason no visitor will ever hit.
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
	});
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

	await page.goto(new URL('/', appOrigin).href, { waitUntil: 'domcontentloaded' });
	await page.evaluate(
		() =>
			new Promise((resolve) => {
				const request = indexedDB.deleteDatabase('flights-cache');
				request.onsuccess = request.onerror = request.onblocked = () => resolve(null);
			})
	);

	await page.goto(url, { waitUntil: 'domcontentloaded' });
	await page
		.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 45000 })
		.catch(() => {});
	const deadline = Date.now() + settleMs;
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
		if (text.includes(token)) leaks.push(`rendered page text -> ${token}`);
		for (const { url: responseUrl, body } of providerBodies) {
			if (body.includes(token)) leaks.push(`${new URL(responseUrl).host} response body -> ${token}`);
		}
	}
	if (leaks.length) {
		invalid = true;
		console.log(`\n${url}`);
		console.log('!!! MEASUREMENT INVALID: this page was served fixture data, not provider data.');
		for (const hit of [...new Set(leaks)].slice(0, 12)) console.log('!!!   ' + hit);
		await context.close();
		continue;
	}

	const cities = await page.$$eval('.route-leg-stopover', (legs) =>
		legs.map((leg) => leg.textContent?.trim().replace(/\s+/g, ' ') ?? '').filter(Boolean)
	);
	const tally = new Map();
	for (const city of cities) tally.set(city, (tally.get(city) ?? 0) + 1);
	// The "which week is cheapest" link carries the stopover codes the search actually
	// produced, so it is the same set as the cards but in IATA and without the styling.
	const stops = await page
		.$eval('a.when-link', (a) => new URL(a.href).searchParams.get('stops'))
		.catch(() => null);

	console.log(`\n${url}`);
	console.log(`  ${(text.match(/\d+ of \d+ itiner\w+/) || ['(no count on page)'])[0]}`);
	console.log(
		`  cities: ${tally.size === 0 ? '(none)' : [...tally].map(([c, n]) => `${c} (${n})`).join(' | ')}`
	);
	console.log(`  stops param: ${stops ?? '(no when-link on page)'}`);
	const byHost = {};
	for (const r of responses) {
		const host = new URL(r.url).host;
		byHost[host] ??= {};
		byHost[host][r.status] = (byHost[host][r.status] ?? 0) + 1;
	}
	console.log(
		`  network: ${Object.entries(byHost)
			.map(([host, codes]) => `${host} ${Object.entries(codes).map(([s, n]) => `${s}x${n}`).join(',')}`)
			.join(' | ')}`
	);
	await context.close();
}

await browser.close();
if (invalid) process.exit(1);
