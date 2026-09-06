/**
 * Issue #399: does the wait the card prints at the origin airport match the ride the
 * traveller is actually waiting for, and what does correcting it do to the order of the
 * list?
 *
 *   node tools/probe-origin-leg.mjs '<results url>' [--city=OPO] [--keep-cache]
 *
 * The sibling of `tools/probe-stopover-edges.mjs`, pointed at the other end of the trip.
 * That one had a contradiction to read off one card: the stopover block and the row under
 * it printed two clocks for one event. This end has none. "Waiting at BCN 2h" is the
 * traveller's own buffer printed back at them, and no second derivation on the page
 * disagrees with it, so the only way to see the defect is to put the card's number beside
 * the timetable the page itself fetched.
 *
 * So this prints three things and asserts none of them:
 *
 * 1. The origin rows of one card, with the ride's own clock and the wait beside it.
 * 2. Every card's four metrics, in list order, under "Best match" and again under
 *    "Fastest". Correcting the origin edge moves `times.total`, which is what the second
 *    of those sorts by and an input to the score the first sorts by. A before-and-after
 *    of this section on the same URL is the ranking measurement issue #399 asks for, and
 *    "Airport wait" is exact minutes under a day, so the per-card delta is readable
 *    straight off it.
 * 3. The Transitous responses for the origin leg as the provider sent them, with the
 *    departure the adapter picks marked. An `arriveBy` plan is chosen by the LAST boarding
 *    that still makes the deadline (providers/transfers/transitous-mapper.ts), and its
 *    `endTime` is the one number no row on the page prints.
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

const ORIGIN_SEGMENTS = ['origin-location', 'transfer-to-origin-airport', 'origin-waiting', 'outbound-flight'];

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();

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
	await page.locator('[data-search-phase="settled"]').waitFor({ state: 'attached', timeout: 240_000 });

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

	for (const mode of ['score', 'duration']) {
		await sortBy(mode);
		console.log(`\n=== list order, sorted by ${mode} ===`);
		const rows = await readList();
		for (const [index, row] of rows.entries()) {
			console.log(`${String(index + 1).padStart(3)}  ${row}`);
		}
	}

	await sortBy('score');
	const index = await pickCard(count);
	const card = cards.nth(index);
	console.log(`\n=== card ${index + 1}, origin end of the trip ===`);
	console.log((await card.locator('.route').first().innerText()).replace(/\n/g, ' '));

	await card.locator('.trip-strip-unfold').click();
	const detail = card.locator('.result-detail');
	await detail.waitFor({ timeout: 30_000 });

	for (const segment of ORIGIN_SEGMENTS) {
		const row = detail.locator(`[data-segment="${segment}"]`).first();
		if ((await row.count()) === 0) continue;
		const when = (await text(row.locator('.tl-when').first())).trim();
		const meta = (await text(row.locator('.tl-meta').first())).trim();
		const label = (await text(row.locator('.tl-content').first())).trim();
		console.log(`${segment.padEnd(28)} when=[${when.replace(/\n/g, ' / ')}]  ${meta.replace(/\n/g, ' ')}`);
		for (const line of label.split('\n')) console.log(`${' '.repeat(30)}${line}`);
	}

	console.log('\n=== origin-leg transit plans, as the provider sent them ===');
	// The origin lookup is the `arriveBy` one that starts where the traveller does, so it is
	// the only one whose `fromPlace` is the URL's own `fromLoc`. Matching on that rather than
	// on request order keeps this right when a search fires several of them for candidates
	// with different outbound flights, which is the normal case.
	const fromLoc = new URL(url).searchParams.get('fromLoc');
	const home = fromLoc ? fromLoc.slice(fromLoc.lastIndexOf('@') + 1) : undefined;
	for (const plan of plans) {
		const query = decodeURIComponent(plan.url);
		if (!query.includes('arriveBy=true')) continue;
		if (home && !query.includes(`fromPlace=${home}`)) continue;
		console.log(query.slice(0, 220));
		// The adapter dedupes by first boarding, sorts ascending and takes the last one, so
		// the marked line is the departure the card is built from.
		const latest = plan.itineraries.reduce(
			(best, current) => (best && best.boards[0] >= (current.boards[0] ?? '') ? best : current),
			undefined
		);
		for (const itinerary of plan.itineraries) {
			const mark = itinerary === latest ? '  <- picked, the last boarding in time' : '';
			console.log(
				`   start=${itinerary.start} end=${itinerary.end} ${itinerary.minutes}m ` +
					`boards=${itinerary.boards.join(',')}${mark}`
			);
		}
	}
} finally {
	await browser.close();
}

async function text(locator) {
	return locator.innerText().catch(() => '');
}

async function sortBy(mode) {
	const body = page.locator('#results-filters-body');
	if (await body.isHidden()) await page.locator('.filters-toggle').click();
	await page.getByLabel('Sort by').selectOption(mode);
	// The list re-sorts synchronously on the change; this settles the DOM before it is read.
	await page.locator('.result-card').first().waitFor();
}

async function readList() {
	return page.evaluate(() =>
		[...document.querySelectorAll('.result-card')].map((card) => {
			const route = card.querySelector('.route')?.innerText.replace(/\s+/g, ' ').trim() ?? '?';
			const price = card.querySelector('.price-total')?.innerText.replace(/\s+/g, ' ').trim() ?? '?';
			const metrics = [...card.querySelectorAll('.metric')]
				.map((metric) => {
					const label = metric.querySelector('.metric-label')?.innerText.trim() ?? '?';
					const value = metric.querySelector('.metric-value')?.innerText.replace(/\s+/g, ' ').trim() ?? '?';
					return `${label} ${value}`;
				})
				.join('  ·  ');
			return `${route.padEnd(38)}  ${price.padEnd(10)}  ${metrics}`;
		})
	);
}

async function pickCard(count) {
	if (!wanted) return 0;
	const cards = page.locator('.result-card');
	for (let i = 0; i < count; i += 1) {
		if ((await cards.nth(i).innerText()).includes(wanted)) return i;
	}
	console.log(`no card mentions "${wanted}"`);
	process.exitCode = 1;
	throw new Error(`no card mentions "${wanted}"`);
}
