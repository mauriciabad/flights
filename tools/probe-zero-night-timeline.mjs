/**
 * Issue #426: what does a traveller see between the two flights when no night is booked?
 *
 *   node tools/probe-zero-night-timeline.mjs [--keep]
 *
 * Two rungs of one ladder, over one pair of cities, both built by the real
 * `buildItineraries` from the same connection resources: a routed 30-minute ride into town
 * and back, and no bed priced, which is the state every search with no stay-provider key
 * lands in. The 0-night rung lands 9am and boards again 9pm the same day; the 1-night rung
 * boards the next evening instead. Nothing else differs.
 *
 * It mounts `ItineraryTimeline` and `StopoverBlock` in a real Chromium and reads the rows
 * and lines back off the rendered DOM, because that is the surface the issue is about and
 * because AGENTS.md is explicit that jsdom cannot see a whole class of Svelte defect. Its
 * own browser, closed at the end, so nothing leaks into anyone else's tab.
 *
 * No network at all: no provider is called, no fixture is served, and the itineraries are
 * built in the page from hand-written flight offers. There is nothing here to mistake for
 * a live result.
 *
 * Prints both rungs' rows with their durations, both blocks' lines, and the totals that
 * have to stay right across the two: `totalPrice`, `times.total`, and the airport waiting
 * that must count the layover once rather than twice.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { newProbeContext } from './probe-browser.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Inside `.svelte-kit`, which is gitignored, so a probe run leaves the worktree clean and
// `root` can stay the repo itself: every import below is then an ordinary relative one.
const stage = path.join(repo, '.svelte-kit', 'probe-zero-night');
const keep = process.argv.includes('--keep');

mkdirSync(stage, { recursive: true });
writeFileSync(
	path.join(stage, 'index.html'),
	`<!doctype html><html><body><div id="app"></div><script type="module" src="./main.ts"></script></body></html>`
);
writeFileSync(
	path.join(stage, 'main.ts'),
	`
import { mount } from 'svelte';
import { buildItineraries } from '../../src/lib/algorithm/build';
import ItineraryTimeline from '../../src/lib/components/ItineraryTimeline.svelte';
import StopoverBlock from '../../src/lib/components/StopoverBlock.svelte';
import type { Airport, Duration, FlightOffer, LocalDateTime } from '../../src/lib/domain';

const country = { isoCode: 'AT', name: 'Austria' };
const city = { name: 'Vienna', coordinates: { latitude: 48.2, longitude: 16.37 }, country };
const airport = (iataCode: string, name: string): Airport => ({
	iataCode,
	name,
	coordinates: { latitude: 48.1, longitude: 16.57 },
	city,
	country,
	sizeClass: 'medium'
});
const at = (local: string): LocalDateTime => ({ local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 });
const flight = (from: string, to: string, departure: string, arrival: string, minutes: number, price: number): FlightOffer => ({
	carrier: { iataCode: 'FR', name: 'Ryanair' },
	flightNumber: 'FR1234',
	departureAirport: from,
	arrivalAirport: to,
	departure: at(departure),
	arrival: at(arrival),
	duration: minutes as Duration,
	price: { minorUnits: price, currency: 'EUR' },
	priceScope: 'per-person',
	baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
	deepLink: 'https://example.invalid/offer'
});
const ride = (minutes: number) => ({ mode: 'transit' as const, duration: minutes as Duration, legs: [] });

const connection = airport('VIE', 'Vienna International');

function rung(onwardDeparture: string, onwardArrival: string) {
	const [itinerary] = buildItineraries({
		originAirport: airport('LGW', 'London Gatwick'),
		destinationAirport: airport('IST', 'Istanbul Airport'),
		outboundOffers: [flight('LGW', 'VIE', '2026-10-06T06:30:00', '2026-10-06T09:00:00', 150, 5000)],
		onwardOffers: [flight('VIE', 'IST', onwardDeparture, onwardArrival, 90, 6000)],
		connectionAirports: { VIE: connection },
		connectionResources: {
			VIE: { transferAnchor: 'city-centre', transferToHotel: ride(30), transferToConnectionAirport: ride(30) }
		},
		waitingTimeRules: [{ waitingTime: 120 as Duration }]
	});
	if (!itinerary) throw new Error('no itinerary built for ' + onwardDeparture);
	return itinerary;
}

const rungs = {
	'0 nights': rung('2026-10-06T21:00:00', '2026-10-06T22:30:00'),
	'1 night': rung('2026-10-07T21:00:00', '2026-10-07T22:30:00')
};

const app = document.getElementById('app')!;
const readings: Record<string, unknown> = {};
for (const [name, itinerary] of Object.entries(rungs)) {
	const host = document.createElement('section');
	host.dataset.rung = name;
	app.appendChild(host);

	const timelineHost = document.createElement('div');
	host.appendChild(timelineHost);
	mount(ItineraryTimeline, { target: timelineHost, props: { itinerary, connectionAirport: connection } });

	const blockHost = document.createElement('div');
	host.appendChild(blockHost);
	mount(StopoverBlock, { target: blockHost, props: { itinerary, connectionLabel: connection.city.name } });

	readings[name] = {
		rows: [...timelineHost.querySelectorAll('[data-segment]')].map((row) => ({
			segment: row.getAttribute('data-segment'),
			label: (row.querySelector('.tl-label')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
			duration: (row.querySelector('.tl-duration')?.textContent ?? '').trim()
		})),
		block: [...blockHost.querySelectorAll('p')].map((p) => p.textContent!.replace(/\\s+/g, ' ').trim()),
		nights: itinerary.nightsInConnection,
		airsideWait: itinerary.airsideWait?.duration ?? null,
		freeTimeMinutes: itinerary.freeTime.duration,
		totalPriceMinorUnits: itinerary.totalPrice.minorUnits,
		times: itinerary.times
	};
}

(window as unknown as { PROBE: unknown }).PROBE = readings;
document.title = 'probe-ready';
`
);

// `$lib/stays`'s barrel reaches the stay picker, which reaches `Flag`, which asks SvelteKit
// where the app is served from. Nothing on the two components under test depends on either
// answer, so the two modules are stubbed rather than the probe booting a whole Kit app to
// get them: `base` is '' and the page is a browser.
writeFileSync(path.join(stage, 'app-paths.ts'), `export const base = '';\nexport const assets = '';\n`);
writeFileSync(
	path.join(stage, 'app-environment.ts'),
	`export const browser = true;\nexport const dev = true;\nexport const building = false;\nexport const version = 'probe';\n`
);

const server = await createServer({
	configFile: false,
	root: repo,
	plugins: [svelte()],
	resolve: {
		alias: {
			$lib: path.join(repo, 'src', 'lib'),
			'$app/paths': path.join(stage, 'app-paths.ts'),
			'$app/environment': path.join(stage, 'app-environment.ts')
		}
	},
	server: { port: 0, strictPort: false },
	logLevel: 'warn'
});
await server.listen();
const url = `http://localhost:${server.config.server.port ?? server.httpServer.address().port}/.svelte-kit/probe-zero-night/index.html`;

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();
const failures = [];
page.on('pageerror', (error) => failures.push(String(error)));
page.on('console', (message) => {
	// The blocked airline logo below reports itself here as a failed resource. That is this
	// probe working, not the page misbehaving.
	if (message.type() !== 'error') return;
	if (message.text().includes('net::ERR_FAILED')) return;
	failures.push(message.text());
});
// No data may enter this page from anywhere. Everything measured below is built in the
// page from hand-written offers, and AGENTS.md has already paid once for an agent reading
// a number that came from somewhere it had not looked at. Blocked rather than merely
// counted, so it cannot arrive: the only thing that asks is `AirlineLogo`, whose carrier
// image is decoration on a row this probe reads the text of.
const blocked = new Set();
await context.route('**', (route) => {
	const target = new URL(route.request().url());
	if (target.hostname === 'localhost' || target.hostname === '127.0.0.1') return route.continue();
	blocked.add(target.origin);
	return route.abort();
});

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => document.title === 'probe-ready', undefined, { timeout: 20_000 });
const readings = await page.evaluate(() => window.PROBE);

for (const [rung, reading] of Object.entries(readings)) {
	console.log(`\n=== ${rung} ===`);
	console.log(
		`nights ${reading.nights}  airsideWait ${reading.airsideWait ?? '-'}  freeTime ${reading.freeTimeMinutes}  ` +
			`total EUR ${(reading.totalPriceMinorUnits / 100).toFixed(2)}`
	);
	console.log(
		`times: total ${reading.times.total}  inFlight ${reading.times.inFlight}  free ${reading.times.free}  ` +
			`airportWaiting ${reading.times.airportWaiting} (origin ${reading.times.originAirportWaiting} + ` +
			`connection ${reading.times.connectionAirportWaiting})`
	);
	console.log('timeline rows:');
	for (const row of reading.rows) console.log(`  ${row.segment.padEnd(30)} ${row.duration.padEnd(8)} ${row.label}`);
	console.log('stopover block:');
	for (const line of reading.block) console.log(`  ${line}`);
}

if (blocked.size > 0) console.log(`\nblocked offsite requests from: ${[...blocked].join(', ')}`);

await browser.close();
await server.close();
if (!keep) rmSync(stage, { recursive: true, force: true });

if (failures.length > 0) {
	console.error('\nMEASUREMENT INVALID');
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
