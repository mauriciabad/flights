/**
 * Issue #387: what the departure-date ladder says on a real search, and what moving one
 * rung costs in provider requests.
 *
 *   node tools/probe-departure-ladder.mjs 'http://localhost:4173/results/?...'
 *
 * The cost half is the point. A ladder that re-priced a bed per rung would be a stay lookup
 * per rung, and a ladder that re-routed would spend Transitous, which issue #267 rationed
 * on purpose because it is volunteer-run. This prints the running per-provider counts
 * beside each interaction so the claim "moving a rung costs nothing" is a measurement
 * rather than an argument.
 *
 * Its own browser, with a real Chrome User-Agent, because `api.skypicker.com` answers a
 * headless UA with a 403 that reads exactly like CORS or an outage. It refuses to report
 * anything if it finds a fixture marker, for the reason `probe-results.mjs` gives.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(
	readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8')
);
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const url = process.argv[2];
if (!url) {
	console.error('usage: node tools/probe-departure-ladder.mjs <results url>');
	process.exit(2);
}
const appOrigin = new URL(url).origin;

const counts = { transitous: 0, osrm: 0, kiwi: 0, ryanair: 0, hostelworld: 0, other: 0 };
const providerBodies = [];

function bucketFor(requestUrl) {
	if (requestUrl.includes('api.transitous.org')) return 'transitous';
	if (requestUrl.includes('project-osrm.org')) return 'osrm';
	if (requestUrl.includes('skypicker.com') || requestUrl.includes('kiwi.com')) return 'kiwi';
	if (requestUrl.includes('ryanair.com')) return 'ryanair';
	if (requestUrl.includes('hostelworld')) return 'hostelworld';
	return 'other';
}

function snapshotCounts() {
	return { ...counts };
}

function costLine(label, before) {
	const moved = Object.entries(counts)
		.filter(([key, value]) => value !== before[key])
		.map(([key, value]) => `${key} ${before[key]} -> ${value}`);
	return `${label}: ${moved.length === 0 ? 'no provider requests at all' : moved.join(', ')}`;
}

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();
const bodyReads = [];
page.on('response', (response) => {
	const responseUrl = response.url();
	if (responseUrl.startsWith(appOrigin) || responseUrl.startsWith('data:')) return;
	if (!/^https?:/.test(responseUrl)) return;
	counts[bucketFor(responseUrl)] += 1;
	bodyReads.push(
		response
			.text()
			.then((body) => providerBodies.push({ url: responseUrl, body: body.slice(0, 20000) }))
			.catch(() => {})
	);
});

/** `tests/shared/search-wait.ts`'s rule, in a script that cannot import TypeScript: wait
 * for evidence the search HAPPENED, never for the words "still searching" to be absent.
 * A page that has not started searching satisfies the absence for the same reason a
 * finished one does, which is what `guard.spec.ts` exists to stop. */
async function waitForSearchToSettle(timeoutMs = 90000) {
	await page.waitForFunction(
		() => document.querySelector('[data-search-phase]')?.getAttribute('data-search-phase') === 'settled',
		undefined,
		{ timeout: timeoutMs }
	);
}

async function readLadder() {
	return page.evaluate(() => {
		const panel = document.querySelector('[data-testid="segment-customiser"]');
		const rungs = [...(panel?.querySelectorAll('[data-testid="departure-rung"]') ?? [])];
		return rungs.map((rung) => ({
			date: rung.getAttribute('data-date'),
			label: rung.textContent?.trim().replace(/\s+/g, ' '),
			current: rung.getAttribute('aria-pressed') === 'true'
		}));
	});
}

async function readTrip() {
	return page.evaluate(() => {
		const card = document.querySelector('.result-card');
		const panel = document.querySelector('[data-testid="segment-customiser"]');
		const current = [...(panel?.querySelectorAll('.picker-row') ?? [])].find((row) =>
			row.textContent?.includes('Current pick')
		);
		return {
			total: card?.querySelector('.price-total')?.textContent?.trim().replace(/\s+/g, ' '),
			outbound: current?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120),
			warning: panel?.textContent?.includes('no connection to make') ?? false
		};
	});
}

try {
	await page.goto(url, { waitUntil: 'domcontentloaded' });
	await waitForSearchToSettle();
	await Promise.allSettled(bodyReads);

	const leaked = FIXTURE_TOKENS.filter((token) =>
		providerBodies.some((entry) => entry.body.includes(token))
	);
	const pageText = await page.evaluate(() => document.body.innerText);
	const onScreen = FIXTURE_TOKENS.filter((token) => pageText.includes(token));
	if (leaked.length > 0 || onScreen.length > 0) {
		console.error('MEASUREMENT INVALID: fixture markers present', { leaked, onScreen });
		process.exit(1);
	}

	await page.locator('.trip-strip-unfold').first().click();
	await page.locator('.itinerary-timeline [data-segment="outbound-flight"]').first().click({
		position: { x: 6, y: 6 }
	});
	await page.waitForTimeout(1500);

	console.log('cards on screen:', await page.locator('.result-card').count());
	console.log('ladder:', JSON.stringify(await readLadder(), null, 1));
	console.log('trip before:', JSON.stringify(await readTrip()));
	console.log('counts after the search:', JSON.stringify(snapshotCounts()));

	const rungs = page.locator('[data-testid="departure-rung"]');
	const total = await rungs.count();
	for (let index = 0; index < total; index += 1) {
		const rung = rungs.nth(index);
		if ((await rung.getAttribute('aria-pressed')) === 'true') continue;
		const date = await rung.getAttribute('data-date');
		const before = snapshotCounts();
		await rung.click();
		await page.waitForTimeout(3000);
		console.log(costLine(`pressed ${date}`, before));
		console.log(`  trip now: ${JSON.stringify(await readTrip())}`);
	}

	console.log('ladder after:', JSON.stringify(await readLadder(), null, 1));
	console.log('final counts:', JSON.stringify(snapshotCounts()));
} finally {
	await context.close();
	await browser.close();
}
