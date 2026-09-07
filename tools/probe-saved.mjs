/**
 * Seeds a browser with saved itineraries and reports what `/saved/` and the search screen
 * do with them, at a phone width and at a desktop one.
 *
 * Issue #434. The saved list is the one screen in this app that must render with no provider,
 * no key and no network, so this deliberately never runs a search: it writes
 * `flights.savedItineraries.v1` straight into `localStorage` and reloads. What appears after
 * that came from the stored snapshot alone, which is exactly the claim the feature makes.
 *
 *   pnpm exec vite preview --port 4231 --strictPort
 *   node tools/probe-saved.mjs http://localhost:4231 [outputDir]
 *
 * Its own Chromium, closed at the end, because the shared Playwright MCP browser carries
 * other agents' tabs and route handlers (AGENTS.md, "Testing the live app without lying to
 * yourself").
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://localhost:4231';
const outDir = process.argv[3] ?? '.';
mkdirSync(outDir, { recursive: true });

const STORAGE_KEY = 'flights.savedItineraries.v1';
const DAY = 86_400_000;
const now = Date.UTC(2026, 8, 8, 9, 0);

function at(local, timeZone, utcOffsetMinutes) {
	return { local, timeZone, utcOffsetMinutes };
}

/** One visit's receipt. Parts add up to the total, the way `build.ts` derives them. */
function observation(daysAgo, visit, flights, bed, nights) {
	return {
		observedAt: now - daysAgo * DAY,
		visit,
		nights,
		flights: { minorUnits: flights, currency: 'EUR' },
		bed: bed === undefined ? undefined : { minorUnits: bed, currency: 'EUR' },
		total: { minorUnits: flights + (bed ?? 0), currency: 'EUR' }
	};
}

const vienna = {
	id: 'VIE@arr=2026-10-16&dep=2026-10-14&from=BCN&to=OTP',
	query: 'arr=2026-10-16&dep=2026-10-14&from=BCN&to=OTP',
	savedAt: now - 21 * DAY,
	trip: {
		origin: { airport: 'BCN', city: 'Barcelona' },
		connection: { airport: 'VIE', city: 'Vienna' },
		destination: { airport: 'OTP', city: 'Bucharest' },
		outboundFlight: {
			carrier: { iataCode: 'VY', name: 'Vueling' },
			flightNumber: 'VY1874',
			departureAirport: 'BCN',
			arrivalAirport: 'VIE',
			departure: at('2026-10-14T09:15:00', 'Europe/Madrid', 120),
			arrival: at('2026-10-14T11:40:00', 'Europe/Vienna', 120)
		},
		onwardFlight: {
			carrier: { iataCode: 'W6', name: 'Wizz Air' },
			flightNumber: 'W64302',
			departureAirport: 'VIE',
			arrivalAirport: 'OTP',
			departure: at('2026-10-16T18:05:00', 'Europe/Vienna', 120),
			arrival: at('2026-10-16T20:45:00', 'Europe/Bucharest', 180)
		},
		nightsInConnection: 2,
		groundLegs: [
			{ leg: 'transferToHotel', mode: 'transit' },
			{ leg: 'transferToConnectionAirport', mode: 'taxi' }
		],
		bed: {
			propertyName: "Wombat's City Hostel Naschmarkt",
			roomKind: 'private',
			rating: { value: 88, outOf: 100 }
		},
		travellers: 1
	},
	prices: [
		observation(21, 'v-a1', 11_800, 6_400, 2),
		observation(14, 'v-a2', 12_400, 6_400, 2),
		observation(9, 'v-a3', 11_200, 6_900, 2),
		observation(3, 'v-a4', 10_400, 6_900, 2),
		observation(0, 'v-a5', 10_400, 6_100, 2)
	]
};

const porto = {
	id: 'OPO@arr=2026-11-03&dep=2026-11-01&from=LGW&to=LIS',
	query: 'arr=2026-11-03&dep=2026-11-01&from=LGW&to=LIS',
	savedAt: now - 2 * DAY,
	trip: {
		origin: { airport: 'LGW', city: 'London' },
		connection: { airport: 'OPO', city: 'Porto' },
		destination: { airport: 'LIS', city: 'Lisbon' },
		outboundFlight: {
			carrier: { iataCode: 'FR', name: 'Ryanair' },
			flightNumber: 'FR2427',
			departureAirport: 'LGW',
			arrivalAirport: 'OPO',
			departure: at('2026-11-01T21:20:00', 'Europe/London', 0),
			arrival: at('2026-11-01T23:55:00', 'Europe/Lisbon', 0)
		},
		onwardFlight: {
			carrier: { iataCode: 'FR', name: 'Ryanair' },
			flightNumber: 'FR6712',
			departureAirport: 'OPO',
			arrivalAirport: 'LIS',
			departure: at('2026-11-02T06:10:00', 'Europe/Lisbon', 0),
			arrival: at('2026-11-02T07:15:00', 'Europe/Lisbon', 0)
		},
		// The airside trip: no night, no bed, no ride into town. The card has to say so
		// rather than print a stay of zero nights.
		nightsInConnection: 0,
		groundLegs: [],
		travellers: 2
	},
	prices: [observation(2, 'v-b1', 7_600, undefined, 0)]
};

const browser = await chromium.launch();
const consoleErrors = [];
const shots = [];

/** Both schemes, every time. The app is dark first and `prefers-color-scheme` has to work in
 * both directions, so a screenshot in one of them proves half the thing. */
for (const scheme of ['dark', 'light']) {
	const context = await browser.newContext({ colorScheme: scheme });
	const page = await context.newPage();
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(`${scheme}: ${message.text()}`);
	});
	page.on('pageerror', (error) => consoleErrors.push(`${scheme}: ${error}`));

	await page.goto(`${origin}/saved/`, { waitUntil: 'load' });
	await page.evaluate(
		([key, value]) => localStorage.setItem(key, value),
		[STORAGE_KEY, JSON.stringify([vienna, porto])]
	);

	// Tall viewports rather than `fullPage`. This app's shell is `height: 100dvh` and the
	// page scrolls inside `.app-content`, so a full-page screenshot captures one viewport of
	// content and a screen of empty document below it.
	for (const [label, width, height] of [
		['375', 375, 2600],
		['1440', 1440, 1600]
	]) {
		await page.setViewportSize({ width, height });

		await page.goto(`${origin}/saved/`, { waitUntil: 'load' });
		// The list is written by the store after hydration, so waiting for `load` alone
		// screenshots the empty prerendered page and reports zero trips.
		await page.locator('article').first().waitFor();
		const savedShot = path.join(outDir, `saved-saved-${scheme}-${label}.png`);
		await page.screenshot({ path: savedShot });
		shots.push(savedShot);

		await page.goto(`${origin}/`, { waitUntil: 'load' });
		await page.locator('section[aria-labelledby="saved-trips-title"]').waitFor();
		const searchShot = path.join(outDir, `saved-search-${scheme}-${label}.png`);
		await page.screenshot({ path: searchShot });
		shots.push(searchShot);
	}

	await context.close();
}

const context = await browser.newContext({ colorScheme: 'dark' });
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(`${origin}/saved/`, { waitUntil: 'load' });
await page.evaluate(
	([key, value]) => localStorage.setItem(key, value),
	[STORAGE_KEY, JSON.stringify([vienna, porto])]
);
await page.goto(`${origin}/saved/`, { waitUntil: 'load' });
await page.locator('article').first().waitFor();
const report = await page.evaluate(() => {
	const cards = [...document.querySelectorAll('article')];
	return {
		heading: document.querySelector('h1')?.textContent?.trim(),
		trips: cards.length,
		routes: cards.map((card) => card.getAttribute('aria-label')),
		logRows: cards.map((card) => card.querySelectorAll('tbody tr').length),
		charts: cards.filter((card) => card.querySelector('polyline')).length,
		unpriced: cards.map((card) => card.querySelectorAll('.log-unpriced').length),
		nowLines: cards.map((card) => card.querySelector('.receipt-now')?.textContent?.replace(/\s+/g, ' ').trim()),
		notes: cards.map((card) => card.querySelector('.receipt-note')?.textContent?.trim())
	};
});

const searchReport = await (async () => {
	await page.goto(`${origin}/`, { waitUntil: 'load' });
	await page.locator('section[aria-labelledby="saved-trips-title"]').waitFor();
	return page.evaluate(() => {
		const section = document.querySelector('section[aria-labelledby="saved-trips-title"]');
		return {
			present: section !== null,
			heading: section?.querySelector('h2')?.textContent?.trim(),
			link: section?.querySelector('a[href$="/saved/"]')?.textContent?.trim(),
			rows: [...(section?.querySelectorAll('li') ?? [])].map((row) =>
				row.textContent?.replace(/\s+/g, ' ').trim()
			)
		};
	});
})();

/** Removing a trip throws away weeks of price log, so the page keeps the record and offers
 *  it back. Proving that here rather than trusting the markup. */
await page.goto(`${origin}/saved/`, { waitUntil: 'load' });
await page.locator('article').first().waitFor();
await page.locator('.action-remove').first().click();
await page.locator('.undo-action').waitFor();
const afterRemove = await page.evaluate(() => ({
	trips: document.querySelectorAll('article').length,
	stored: JSON.parse(localStorage.getItem('flights.savedItineraries.v1') ?? '[]').length
}));
await page.locator('.undo-action').click();
await page.locator('article').first().waitFor();
const afterUndo = await page.evaluate(() => {
	const stored = JSON.parse(localStorage.getItem('flights.savedItineraries.v1') ?? '[]');
	return {
		trips: document.querySelectorAll('article').length,
		stored: stored.length,
		// The whole record comes back, not a fresh one: the log it took five visits to build
		// is still under it.
		logLengths: stored.map((entry) => entry.prices.length)
	};
});

await page.evaluate(() => localStorage.removeItem('flights.savedItineraries.v1'));
await page.goto(`${origin}/saved/`, { waitUntil: 'load' });
await page.locator('[role="status"]').waitFor();
const empty = await page.evaluate(() => ({
	title: document.querySelector('.empty-state-title')?.textContent?.trim(),
	description: document.querySelector('.empty-state-description')?.textContent?.trim(),
	action: document.querySelector('.empty-state-action a')?.textContent?.trim()
}));
const emptyShot = path.join(outDir, 'saved-empty-dark-1440.png');
await page.screenshot({ path: emptyShot });
shots.push(emptyShot);

await browser.close();

console.log(
	JSON.stringify(
		{ saved: report, search: searchReport, afterRemove, afterUndo, empty, shots, consoleErrors },
		null,
		2
	)
);
if (consoleErrors.length > 0) process.exit(1);
