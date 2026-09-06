/**
 * What vehicles a search's transit legs actually ride, straight off the Transitous
 * responses the page received. Issue #415.
 *
 *   node tools/probe-transit-legs.mjs --url 'http://localhost:41415/results/?...'
 *
 * `providers/transfers/transit-fare-table.ts` multiplies a per-ride fare by
 * `countTransitBoardings`, so the boarding count is an input to money and deserves to be
 * looked at rather than assumed. It is not what it looks like at Birmingham: the plan
 * behind `docs/ACCEPTANCE.md`'s own trip is
 *
 *     OTHER/AIR + LONG_DISTANCE/Avanti + BUS/16
 *
 * and `OTHER/AIR` is the Air-Rail Link, which Birmingham Airport's own site calls "a
 * complimentary service". Three boardings, one of them free. That measurement is why the
 * BHX card carries no `onwardMinorUnits` despite an nBus single buying one bus journey, and
 * this file is how to re-take it.
 *
 * It reads responses rather than the rendered picker on purpose. The picker prints a label
 * per mode and `TRANSIT_MODE_LABELS` falls back to "Transit" for anything it does not name,
 * so a free monorail and an unmapped tram read identically on screen and differently here.
 *
 * Its own Chromium, closed at the end. Never the shared MCP browser: AGENTS.md, "Testing
 * the live app without lying to yourself".
 */
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

function flag(name) {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? undefined : process.argv[at + 1];
}

const url = flag('url');
if (!url) throw new Error('pass --url');
const perPlan = Number(flag('itineraries') ?? 3);

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();

const plans = [];
page.on('response', async (response) => {
	if (!/transitous|motis/i.test(response.url())) return;
	try {
		plans.push({ url: response.url(), body: await response.json() });
	} catch {
		// A non-JSON body here is an error page, and the status alone is the story.
		plans.push({ url: response.url(), status: response.status(), body: null });
	}
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page
	.locator('[data-search-phase="settled"]')
	.waitFor({ state: 'attached', timeout: 240000 })
	.catch(() => console.log('!! the search never reached data-search-phase="settled"'));
await page.waitForTimeout(4000);

console.log(`${plans.length} Transitous plan responses\n`);
for (const plan of plans) {
	const params = new URL(plan.url).searchParams;
	console.log(
		`from ${params.get('fromPlace')} to ${params.get('toPlace')}  ` +
			`arriveBy=${params.get('arriveBy')} time=${params.get('time')}`
	);
	if (!plan.body) {
		console.log(`  (HTTP ${plan.status}, no JSON body)\n`);
		continue;
	}
	const itineraries = plan.body.itineraries ?? [];
	if (itineraries.length === 0) console.log('  (no itineraries)');
	for (const itinerary of itineraries.slice(0, perPlan)) {
		const ridden = (itinerary.legs ?? []).filter((leg) => leg.mode !== 'WALK');
		console.log(
			`  ${ridden.length} boardings: ` +
				(ridden
					.map((leg) => `${leg.mode}${leg.routeShortName ? `/${leg.routeShortName}` : ''}`)
					.join(' + ') || '(walking only)')
		);
	}
	console.log('');
}

await browser.close();
