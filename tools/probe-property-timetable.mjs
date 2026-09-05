/**
 * Issue #267, the timetable half: does a swapped bed say its journey is road only, does
 * asking for the bus actually get one, and does the press look like it is working while it
 * runs?
 *
 *   node tools/probe-property-timetable.mjs '<results url>' "<property>" ["<property>" ...]
 *
 * Name several properties and it swaps and presses on each in turn, which is how the ration
 * gets checked rather than asserted. The search spends most of the twelve itself, so the
 * third or fourth press should be refused and say so, with nothing sent. If the page ever
 * handed the panel a budget of its own, every press would succeed and this is the run that
 * would show it.
 *
 * `probe-stay-routing.mjs` proves the road route lands. This picks up where that stops: it
 * opens the leg's picker, reads the notice, presses "Check public transport", and counts
 * what the press sends to Transitous. That count is the whole argument. Two requests per
 * press against a volunteer-run service is a number somebody has to be able to check rather
 * than take on trust, and the reason the lookup is behind a press at all.
 *
 * It also reads the cost line before pressing, because a button that spends somebody's
 * allowance without saying so is the defect this feature exists to avoid.
 *
 * ## Issue #384: what this was reaching for, and where those things went
 *
 * It cannot have run since #278. It clicked "Show details", a control #278 deleted, and then
 * scoped the picker to `[data-segment="transfer-to-hotel"] .tl-expansion` inside the card.
 * That expansion still exists in `ItineraryTimeline.svelte` and renders empty, because
 * `ResultDetail.svelte` passes it no snippet. Both pickers moved to `SegmentCustomiser`,
 * mounted beside the list as a rail above 64rem and a sheet below it. So the sequence here is
 * the one `tests/e2e/route-previews.spec.ts` uses: unfold the trip strip, pick a timeline
 * row, and read the panel at `[data-testid="segment-customiser"]`.
 *
 * ## Issue #385: the press samples itself
 *
 * The press used to unmount the button it was made on, over a notice that went on reading
 * "Public transport was not looked up for this property" for the whole round trip. So this
 * samples the button and the notice every 150ms from the moment of the click and prints each
 * distinct state with the time it first appeared. How long that window lasts against the real
 * service is a number no mocked test can produce.
 *
 * ## It cannot mock, and says so rather than passing quietly
 *
 * `guard.spec.ts` forbids a probe from answering a request, which is the right rule: an
 * instrument that supplies its own answers measures itself. So this needs a route that really
 * returns a second bed, and when it cannot reach the press it exits non-zero naming the step
 * it got stuck on. A probe that returns 0 having measured nothing reads exactly like a probe
 * that measured something fine.
 *
 * Its own Chromium, closed at the end, IndexedDB cleared unless told not to.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8'));
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const url = process.argv[2];
const wantedProperties = process.argv.slice(3).filter((argument) => !argument.startsWith('--'));
if (!url || wantedProperties.length === 0) throw new Error('pass a results URL and at least one property name');
const keepCache = process.argv.includes('--keep-cache');
const appOrigin = new URL(url).origin;

const browser = await chromium.launch();
// Kiwi's public endpoint answers a User-Agent that says headless with a 403 carrying no CORS
// headers and no status the page can read, so a probe on the default UA reports an outage of
// its own making.
const context = await newProbeContext(browser);
const page = await context.newPage();

let osrmRequests = 0;
let transitousRequests = 0;
const transitousUrls = [];
page.on('request', (r) => {
	const host = new URL(r.url()).host;
	if (host === 'routing.openstreetmap.de') osrmRequests += 1;
	if (host.endsWith('transitous.org') || host.endsWith('motis-project.de')) {
		transitousRequests += 1;
		transitousUrls.push(r.url());
	}
});
page.on('pageerror', (e) => console.log('PAGE ERROR', String(e).slice(0, 400)));
page.on('console', (m) => {
	if (m.type() === 'error') console.log('CONSOLE ERROR', m.text().slice(0, 400));
});

/** Everything below is a measurement, so a step that cannot be reached ends the run loudly.
 * A shorter report is otherwise indistinguishable from a clean one. */
function unreachable(step, detail) {
	console.log(`\nCOULD NOT REACH THE PRESS at: ${step}`);
	console.log(detail);
	return 3;
}

let exitCode = 0;

await page.goto(appOrigin);
if (!keepCache) {
	await page.evaluate(
		() =>
			new Promise((r) => {
				const req = indexedDB.deleteDatabase('flights-cache');
				req.onsuccess = req.onerror = req.onblocked = () => r();
			})
	);
}

await page.goto(url);
// Issue #337's rule, which this probe was still on the wrong side of: "still searching" is
// absent from a page that has not started for the same reason it is absent from a page that
// has finished, so waiting for it to go away is a wait satisfied by absence. It caught this
// run out on 2026-09-06 and reported no itinerary against a URL that has one.
// `data-search-phase` is written from a snapshot carrying `done`, so `settled` is evidence
// the search actually happened.
await page
	.locator('[data-search-phase="settled"]')
	.waitFor({ state: 'attached', timeout: 180_000 });

const card = page.locator('.result-card').first();
const detail = page.locator('.result-detail').first();
const panel = page.getByTestId('segment-customiser');

const unfold = card.locator('.trip-strip-unfold');
if ((await unfold.count()) === 0) {
	exitCode = unreachable(
		'unfolding the trip strip',
		'no .trip-strip-unfold on the first card, so this URL produced no itinerary to open'
	);
} else {
	await unfold.click();
	await detail.waitFor({ timeout: 30_000 });
}

const pageText = await page.evaluate(() => document.body.innerText);
const leaked = FIXTURE_TOKENS.filter((t) => pageText.includes(t));
if (leaked.length > 0) {
	console.log('MEASUREMENT INVALID: fixture markers on the page:', leaked.join(', '));
	await browser.close();
	process.exit(2);
}

const flat = (s) => s.replace(/\s*\n\s*/g, ' | ').trim();
const rowText = async (segment) => {
	const row = detail.locator(`[data-segment="${segment}"]`);
	return (await row.count()) > 0 ? flat(await row.first().innerText()) : '(row absent)';
};

/** The row's top-left corner rather than its centre, the same corner `results-ui.ts` clicks:
 * a row's centre can be the waiting-time stepper, and `ItineraryTimeline.handleRowClick`
 * ignores a click that lands on a control inside the row. */
async function pickSegment(segment) {
	const row = detail.locator(`[data-segment="${segment}"]`).first();
	if ((await row.count()) === 0) return false;
	await row.click({ position: { x: 6, y: 6 } });
	await panel.waitFor({ timeout: 15_000 });
	await page.waitForTimeout(200);
	return true;
}

if (exitCode === 0) {
	console.log('\n----- as opened -----');
	console.log('TO-BED   :', await rowText('transfer-to-hotel'));
	console.log('FROM-BED :', await rowText('transfer-to-connection-airport'));
	console.log(`\nsearch cost: ${osrmRequests} OSRM, ${transitousRequests} Transitous`);
}

for (const wanted of wantedProperties) {
	if (exitCode !== 0) break;

	if (!(await pickSegment('free-time'))) {
		exitCode = unreachable(
			'opening the stay picker',
			'the timeline has no free-time row, so this trip has no stopover to book a bed in'
		);
		break;
	}
	const alt = panel.locator('.alt-card', { hasText: wanted }).first();
	if ((await alt.count()) === 0) {
		const offered = await panel.locator('.alt-card').allInnerTexts();
		exitCode = unreachable(
			`swapping to "${wanted}"`,
			offered.length === 0
				? 'the panel offers no alternative beds at all'
				: `no alternative card named it. Offered:\n${offered.map(flat).join('\n')}`
		);
		break;
	}

	const beforeSwap = { osrm: osrmRequests, transitous: transitousRequests };
	await alt.click();

	for (let elapsed = 0; elapsed < 40_000; elapsed += 1000) {
		await page.waitForTimeout(1000);
		if (!(await rowText('transfer-to-hotel')).includes('Nothing routed')) break;
	}

	console.log(`\n===== "${wanted}" =====`);
	console.log('TO-BED   :', await rowText('transfer-to-hotel'));
	console.log('FROM-BED :', await rowText('transfer-to-connection-airport'));
	console.log(
		`the swap cost: ${osrmRequests - beforeSwap.osrm} OSRM, ${transitousRequests - beforeSwap.transitous} Transitous`
	);

	// One panel is mounted at a time, so picking the leg both closes the stay picker and opens
	// the thing being measured.
	if (!(await pickSegment('transfer-to-hotel'))) {
		exitCode = unreachable('opening the leg to the bed', 'the timeline has no transfer-to-hotel row');
		break;
	}

	const notice = panel.getByTestId('transit-notice').first();
	console.log('NOTICE   :', (await notice.count()) > 0 ? flat(await notice.innerText()) : '(no notice)');
	const offer = panel.locator('.transit-check').first();
	console.log('OFFER    :', (await offer.count()) > 0 ? flat(await offer.innerText()) : '(no offer)');

	const check = panel.getByRole('button', { name: 'Check public transport' }).first();
	if ((await check.count()) === 0) {
		exitCode = unreachable(
			`pressing on "${wanted}"`,
			'the panel offers no press on this leg. `canCheckTransit` offers it only for a bed the search never routed to, so either the swap landed back on the bed the search picked or this leg already has its timetable.'
		);
		break;
	}

	/**
	 * Issue #385: what the button and the notice do between the press and the answer.
	 *
	 * One DOM read rather than four locator calls. The first draft asked `count()` and then
	 * `isDisabled()`, the button unmounted between the two, and `isDisabled()` sat waiting
	 * for it until Playwright's 30s timeout killed the run. The state being sampled is
	 * exactly the state that is changing, so it has to be read in one go.
	 */
	const readPressState = () =>
		panel.evaluate((root) => {
			const pressable = [...root.querySelectorAll('button')].find((element) =>
				element.textContent?.includes('Check public transport')
			);
			const line = root.querySelector('[data-testid="transit-notice"]');
			return {
				button: !pressable ? 'gone' : pressable.disabled ? 'present, busy' : 'present, pressable',
				answer: line ? (line.getAttribute('data-transit-answer') ?? '(none)') : '(gone)',
				notice: line ? (line.textContent ?? '').replace(/\s+/g, ' ').trim() : '(notice gone)'
			};
		});

	const beforePress = { osrm: osrmRequests, transitous: transitousRequests };
	const pressedAt = Date.now();
	await check.click();

	let last = '';
	for (let elapsed = 0; elapsed < 40_000; elapsed = Date.now() - pressedAt) {
		const state = await readPressState();
		const line = `button ${state.button}, data-transit-answer=${state.answer}, "${state.notice}"`;
		if (line !== last) {
			console.log(`PRESS +${String(Date.now() - pressedAt).padStart(5)}ms:`, line);
			last = line;
		}
		if (state.button === 'gone' && !state.notice.includes('Public transport was not looked up')) break;
		await page.waitForTimeout(150);
	}

	console.log('AFTER    :', await rowText('transfer-to-hotel'));
	console.log('NOTICE   :', (await notice.count()) > 0 ? flat(await notice.innerText()) : '(no notice)');
	console.log('PICKER   :', flat(await panel.locator('.transport-picker').first().innerText()).slice(0, 400));
	console.log(
		`the press cost: ${osrmRequests - beforePress.osrm} OSRM, ${transitousRequests - beforePress.transitous} Transitous`
	);
	for (const sent of transitousUrls.slice(beforePress.transitous)) console.log('  sent:', sent);
}

console.log(`\nin total: ${osrmRequests} OSRM, ${transitousRequests} Transitous`);
await browser.close();
process.exit(exitCode);
