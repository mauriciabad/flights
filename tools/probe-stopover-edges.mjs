/**
 * Issue #368: does the stopover block agree with the timeline about when the traveller
 * leaves for the connection airport, and about when the stopover starts?
 *
 *   node tools/probe-stopover-edges.mjs '<results url>' [--city=OPO] [--keep-cache]
 *
 * `--city` picks the card whose text mentions it, since the card a search opens on moves
 * (#369 changed it once already) and a probe pinned to index 0 measures whatever happens to
 * be there. Without it, the first card.
 *
 * Both edges of `itinerary.freeTime` used to be arithmetic: landing plus the ride out, and
 * the check-in deadline minus the ride back. The timeline row beside each of them prints
 * the transit schedule's own clock, which is the service that actually runs. On the owner's
 * BCN to BVC search those two answers were 1h 28m apart on the closing edge.
 *
 * So this reads the block's two edge lines and the two transfer rows' clocks off one card
 * and prints them together, plus the wait rows and the flights, so the whole layover can be
 * added up by eye, and the raw Transitous responses underneath, which carry the one number
 * no row prints: `arrival`, when the service caught actually reaches the door.
 *
 * It asserts nothing. Which number is right is the issue's argument, and a probe that
 * decided that would only be able to confirm itself.
 *
 * Its own Chromium, closed at the end, IndexedDB cleared unless told not to.
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
if (!url) throw new Error('pass a results URL');
const keepCache = process.argv.includes('--keep-cache');
const wanted = (process.argv.find((arg) => arg.startsWith('--city=')) ?? '--city=').slice(7);
const appOrigin = new URL(url).origin;

const SEGMENTS = [
	'origin-location',
	'transfer-to-origin-airport',
	'origin-waiting',
	'outbound-flight',
	'transfer-to-hotel',
	'free-time',
	'transfer-to-connection-airport',
	'connection-waiting',
	'onward-flight',
	'transfer-to-destination-location',
	'destination-location'
];

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();
// Transitous answers carry the one number no row on the page prints: when the service the
// app picked actually gets the traveller to the door. `intended` is on the row, `arrival`
// is not, and the opening edge of the stopover is exactly that arrival.
const plans = [];
page.on('response', async (response) => {
	if (!/transitous|motis/i.test(response.url())) return;
	try {
		const body = await response.json();
		if (!Array.isArray(body?.itineraries)) return;
		plans.push({
			url: response.url(),
			itineraries: body.itineraries.map((itinerary) => ({
				start: itinerary.startTime,
				end: itinerary.endTime,
				minutes: Math.round((itinerary.duration ?? 0) / 60),
				boards: (itinerary.legs ?? []).filter((leg) => leg.mode !== 'WALK').map((leg) => leg.startTime)
			}))
		});
	} catch {
		// A non-JSON body is not a plan response; nothing to read and nothing to report.
	}
});
page.on('pageerror', (e) => console.log('PAGE ERROR', String(e).slice(0, 300)));
page.on('console', (m) => {
	if (m.type() === 'error') console.log('CONSOLE ERROR', m.text().slice(0, 300));
});

try {
	await page.goto(appOrigin);
	if (!keepCache) {
		await page.evaluate(
			() =>
				new Promise((resolve) => {
					const request = indexedDB.deleteDatabase('flights-cache');
					request.onsuccess = request.onerror = request.onblocked = () => resolve();
				})
		);
	}

	await page.goto(url);
	await page
		.locator('[data-search-phase="settled"]')
		.waitFor({ state: 'attached', timeout: 240_000 });

	const pageText = await page.evaluate(() => document.body.innerText);
	const leaked = FIXTURE_TOKENS.filter((token) => pageText.includes(token));
	if (leaked.length > 0) {
		console.log('MEASUREMENT INVALID: fixture markers on the page:', leaked.join(', '));
		// `process.exitCode` and a throw, never `process.exit`: exiting here would skip the
		// `finally` that closes the browser, and a probe that leaks a Chromium is the thing
		// AGENTS.md spends a section on.
		process.exitCode = 2;
		throw new Error('fixture markers on the page');
	}

	const cards = page.locator('.result-card');
	const count = await cards.count();
	console.log(`${count} result cards`);

	let index = 0;
	if (wanted) {
		index = -1;
		for (let i = 0; i < count; i += 1) {
			const text = await cards.nth(i).innerText();
			if (text.includes(wanted)) {
				index = i;
				break;
			}
		}
		if (index === -1) {
			console.log(`no card mentions "${wanted}"`);
			for (let i = 0; i < count; i += 1) {
				console.log(`  card ${i}: ${(await cards.nth(i).innerText()).split('\n').slice(0, 3).join(' | ')}`);
			}
			process.exitCode = 1;
			throw new Error(`no card mentions "${wanted}"`);
		}
	}

	const card = cards.nth(index);
	await card.locator('.trip-strip-unfold').click();
	const detail = card.locator('.result-detail');
	await detail.waitFor({ timeout: 30_000 });

	console.log('\n=== stopover block ===');
	const block = detail.locator('.stopover').first();
	console.log(await block.innerText());

	console.log('\n=== timeline rows, in trip order ===');
	for (const segment of SEGMENTS) {
		const row = detail.locator(`[data-segment="${segment}"]`).first();
		if ((await row.count()) === 0) continue;
		const when = (await row.locator('.tl-when').first().innerText().catch(() => '')).trim();
		const meta = (await row.locator('.tl-meta').first().innerText().catch(() => '')).trim();
		const label = (await row.locator('.tl-content').first().innerText().catch(() => '')).trim();
		console.log(
			`${segment.padEnd(32)} when=[${when.replace(/\n/g, ' / ')}]  ${meta.replace(/\n/g, ' ')}`
		);
		for (const line of label.split('\n')) console.log(`${' '.repeat(34)}${line}`);
	}

	console.log('\n=== metrics ===');
	const metrics = detail.locator('.metrics, [data-metrics]').first();
	if ((await metrics.count()) > 0) console.log(await metrics.innerText());

	console.log('\n=== transit plans, as the provider sent them ===');
	for (const plan of plans) {
		console.log(decodeURIComponent(plan.url).slice(0, 220));
		for (const itinerary of plan.itineraries) {
			console.log(
				`   start=${itinerary.start} end=${itinerary.end} ${itinerary.minutes}m boards=${itinerary.boards.join(',')}`
			);
		}
	}
} finally {
	await browser.close();
}
