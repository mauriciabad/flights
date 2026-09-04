/**
 * Counts what one search costs Kiwi's keyless endpoint, split by query, and then measures
 * what a reload costs once the fares have aged past their TTL. Issue #165's acceptance
 * test, and the Kiwi twin of probe-ryanair-requests.mjs.
 *
 * The third phase is the one worth having. A reload seconds after a search is free on any
 * branch, because nothing has expired yet; the complaint in #165 is what happens half an
 * hour later, and waiting half an hour is not a test. So the entries are aged in place —
 * `storedAt` rewound inside IndexedDB, which is where this app's response cache lives and
 * which survives clearing site data (AGENTS.md) — and the reload is measured against that.
 *
 * The split by query matters for the same reason it does for Ryanair: fares and the route
 * graph move for different reasons, and a total alone cannot tell a cache regression from
 * a search that found more candidates worth pricing.
 *
 *   node tools/probe-kiwi-requests.mjs                              # production
 *   node tools/probe-kiwi-requests.mjs http://127.0.0.1:41651       # a local build
 *   node tools/probe-kiwi-requests.mjs <base> 'from=BCN&to=TLL&...' 30
 */
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const base = (process.argv[2] ?? 'https://flights.mauri.app').replace(/\/$/, '');
const target = `${base}/results/?${process.argv[3] ?? 'from=BCN&to=TLL&dep=2026-10-06&arr=2026-10-12&people=1'}`;
/** How far to rewind the cache before the third load. 30 minutes is #165's own wording,
 * and it is past the 15-minute fare TTL and inside the 24-hour route-graph TTL. */
const ageMinutes = Number(process.argv[4] ?? 30);

const KIWI_HOST = 'api.skypicker.com';

function queryOf(url) {
	const feature = new URL(url).searchParams.get('featureName') ?? '';
	if (feature.includes('OnePerCity')) return 'route graph, one per airport';
	if (feature.includes('SearchOneWay')) return 'fares';
	return `other (${feature || 'no featureName'})`;
}

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();

const kiwi = [];
page.on('response', (r) => {
	if (r.url().includes(KIWI_HOST)) kiwi.push({ url: r.url(), status: r.status() });
});
page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

/** Milliseconds from `goto` to the first non-zero itinerary count on screen, or null if
 * the search never produced one. This is the number the person feels: #165 reports "a
 * reload showed nothing for 4000ms" on a page whose answer was already in IndexedDB. */
async function search(label) {
	const before = kiwi.length;
	const startedAt = Date.now();
	await page.goto(target, { waitUntil: 'domcontentloaded' });

	let firstResultMs = null;
	// Settle on "no new Kiwi request for 10s" rather than a fixed wait: a 46-request
	// search takes far longer than a 6-request one, and a fixed wait undercounts the slow
	// one, which is the one being argued about.
	let seen = -1;
	let quietSince = Date.now();
	const deadline = Date.now() + 240_000;
	while (Date.now() < deadline) {
		await page.waitForTimeout(250);
		if (firstResultMs === null) {
			const text = await page.evaluate(() => document.body.innerText);
			if (/[1-9]\d* of \d+ itiner/.test(text)) firstResultMs = Date.now() - startedAt;
		}
		if (kiwi.length !== seen) {
			seen = kiwi.length;
			quietSince = Date.now();
		} else if (Date.now() - quietSince > 10_000) break;
	}

	const slice = kiwi.slice(before);
	const counts = new Map();
	for (const { url, status } of slice) {
		const key = `${queryOf(url)} [${status}]`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const text = await page.evaluate(() => document.body.innerText);
	console.log(`\n=== ${label}: ${slice.length} requests to ${KIWI_HOST} ===`);
	for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${String(v).padStart(3)}  ${k}`);
	}
	console.log(`  found: ${(text.match(/\d+ of \d+ itiner\w+/) ?? ['(no itinerary count on the page)'])[0]}`);
	console.log(`  first result on screen after: ${firstResultMs === null ? 'never' : `${firstResultMs}ms`}`);
	return { requests: slice.length, firstResultMs };
}

/** Rewinds every cached entry by `minutes`, so a reload sees the cache a real user would
 * see that long after their search. Returns how many entries it touched, since "0 aged"
 * and "0 requests" together mean the measurement proved nothing. */
async function ageCache(minutes) {
	return page.evaluate(
		(ms) =>
			new Promise((resolve, reject) => {
				const open = indexedDB.open('flights-cache', 1);
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const tx = db.transaction('entries', 'readwrite');
					const store = tx.objectStore('entries');
					let touched = 0;
					store.openCursor().onsuccess = (event) => {
						const cursor = event.target.result;
						if (!cursor) return;
						cursor.update({ ...cursor.value, storedAt: cursor.value.storedAt - ms });
						touched += 1;
						cursor.continue();
					};
					tx.oncomplete = () => {
						db.close();
						resolve(touched);
					};
					tx.onerror = () => reject(tx.error);
				};
			}),
		minutes * 60_000
	);
}

// A fresh context already has an empty localStorage and Cache Storage, but IndexedDB is
// where this app's response cache lives and it survives everything else (AGENTS.md).
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.evaluate(
	() =>
		new Promise((resolve) => {
			const req = indexedDB.deleteDatabase('flights-cache');
			req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined);
		})
);

const cold = await search('cold cache');
const warm = await search('reload, nothing expired yet');
const aged = await ageCache(ageMinutes);
console.log(`\n(aged ${aged} cache entries by ${ageMinutes} minutes)`);
const stale = await search(`reload ${ageMinutes} minutes later`);

console.log(
	`\n### ${base}\n### cold=${cold.requests}  warm=${warm.requests}  after-${ageMinutes}min=${stale.requests}` +
		`\n### first result on screen: cold=${cold.firstResultMs}ms warm=${warm.firstResultMs}ms after-${ageMinutes}min=${stale.firstResultMs}ms`
);
await browser.close();
