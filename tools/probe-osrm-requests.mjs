/**
 * Counts what one search actually costs OSRM, split by profile, and says how much of that
 * total is the same question asked twice. Issue #213's measurement.
 *
 * A bare total cannot tell "this search had more stopovers to route" from "this search
 * asked for the same coordinate pair four times", and #213 is entirely about the second.
 * So the report breaks the requests into three groups a fix can move independently:
 *
 *   distinct URLs          how many different questions were asked
 *   repeats                the same URL asked more than once in one page load
 *   reversed pairs         A->B and B->A both asked, which is two questions by OSRM's
 *                          rules (one-way streets) but one route to a traveller
 *
 * `routing.openstreetmap.de` is a volunteer-run demo instance that has already refused
 * this project's traffic for a stretch, so this waits between the cold and warm runs
 * rather than firing them back to back. Raise the gap, never lower it.
 *
 *   node tools/probe-osrm-requests.mjs                       # production
 *   node tools/probe-osrm-requests.mjs http://127.0.0.1:4293 # a local static-server build
 *   node tools/probe-osrm-requests.mjs http://127.0.0.1:4293 'from=BCN&to=OTP&dep=...'
 */
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const base = (process.argv[2] ?? 'https://flights.mauri.app').replace(/\/$/, '');
const query = process.argv[3] ?? 'from=BVC&to=PFO&dep=2026-10-06&arr=2026-10-12';
const target = `${base}/results/?${query}`;
const GAP_BETWEEN_RUNS_MS = Number(process.env.OSRM_PROBE_GAP_MS ?? 90_000);

/** `/routed-car/route/v1/driving/2.1,41.3;2.2,41.4` -> profile, service and the pair. */
function parseOsrm(rawUrl) {
	const url = new URL(rawUrl);
	const parts = url.pathname.split('/').filter(Boolean);
	const profile = parts[0] ?? '(none)';
	const service = parts[1] ?? '(none)';
	const coords = decodeURIComponent(parts[4] ?? '');
	const [from, to] = coords.split(';');
	return { profile, service, from, to, key: `${profile} ${service} ${coords}` };
}

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();

const seen = [];
page.on('response', (r) => {
	if (r.url().includes('routing.openstreetmap.de')) seen.push({ url: r.url(), status: r.status() });
});
page.on('requestfailed', (r) => {
	if (r.url().includes('routing.openstreetmap.de'))
		seen.push({ url: r.url(), status: r.failure()?.errorText ?? 'failed' });
});

// When each request LEFT the browser, which is a different question from how many there
// were. osrm.ts asks for 1100 ms between requests; whether it gets that is the difference
// between a polite trickle and a burst a shared demo instance refuses.
const startedAt = [];
page.on('request', (r) => {
	if (r.url().includes('routing.openstreetmap.de')) startedAt.push(Date.now());
});

async function search(label) {
	const before = seen.length;
	const startedBefore = startedAt.length;
	await page.goto(target, { waitUntil: 'domcontentloaded' });

	// Settle on "no new OSRM request for 12s". A fixed wait would undercount the expensive
	// run, which is the one this probe exists to argue about.
	let count = -1;
	let quietSince = Date.now();
	const deadline = Date.now() + 240_000;
	while (Date.now() < deadline) {
		await page.waitForTimeout(1000);
		if (seen.length !== count) {
			count = seen.length;
			quietSince = Date.now();
		} else if (Date.now() - quietSince > 12_000) break;
	}

	const slice = seen.slice(before);
	const byUrl = new Map();
	const byProfile = new Map();
	const pairs = new Set();
	let failures = 0;
	for (const { url, status } of slice) {
		const { profile, service, from, to, key } = parseOsrm(url);
		byUrl.set(key, (byUrl.get(key) ?? 0) + 1);
		const bucket = `${profile}/${service}`;
		byProfile.set(bucket, (byProfile.get(bucket) ?? 0) + 1);
		pairs.add(`${profile}|${from}|${to}`);
		if (typeof status !== 'number' || status >= 400) failures++;
	}

	let reversed = 0;
	for (const pair of pairs) {
		const [profile, from, to] = pair.split('|');
		if (pairs.has(`${profile}|${to}|${from}`)) reversed++;
	}
	const repeats = [...byUrl.values()].reduce((sum, n) => sum + (n - 1), 0);

	const starts = startedAt.slice(startedBefore);
	const gaps = starts.slice(1).map((at, i) => at - starts[i]);
	// A "burst" is every run of requests that left less than 300 ms apart. osrm.ts asks for
	// 1100 ms, so any burst longer than one request means that spacing did not happen.
	let biggestBurst = starts.length > 0 ? 1 : 0;
	let currentBurst = biggestBurst;
	for (const gap of gaps) {
		currentBurst = gap < 300 ? currentBurst + 1 : 1;
		biggestBurst = Math.max(biggestBurst, currentBurst);
	}

	const text = await page.evaluate(() => document.body.innerText);
	console.log(`\n=== ${label}: ${slice.length} OSRM requests ===`);
	for (const [k, v] of [...byProfile].sort((a, b) => b[1] - a[1]))
		console.log(`  ${String(v).padStart(3)}  ${k}`);
	console.log(`  distinct URLs:      ${byUrl.size}`);
	console.log(`  repeated URLs:      ${repeats} (requests that asked a question already asked)`);
	console.log(`  reversed pairs:     ${reversed} of ${pairs.size} distinct pairs also asked backwards`);
	console.log(`  non-200:            ${failures}`);
	console.log(`  biggest burst:      ${biggestBurst} requests left the browser <300ms apart`);
	console.log(
		`  first to last send: ${starts.length > 1 ? `${((starts[starts.length - 1] - starts[0]) / 1000).toFixed(1)}s` : 'n/a'}`
	);
	console.log(`  gaps between sends: ${gaps.length === 0 ? '(none)' : gaps.join('ms, ') + 'ms'}`);
	if (repeats > 0) {
		console.log('  the repeats:');
		for (const [k, v] of [...byUrl].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]))
			console.log(`    x${v}  ${k}`);
	}
	console.log(`  found: ${(text.match(/\d+ of \d+ itiner\w+/) ?? ['(no itinerary count on the page)'])[0]}`);
	return {
		total: slice.length,
		distinct: byUrl.size,
		repeats,
		reversed,
		pairs: pairs.size,
		failures,
		biggestBurst
	};
}

// A fresh context starts with an empty localStorage and Cache Storage, but this app's
// response cache lives in IndexedDB and survives both (AGENTS.md).
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.evaluate(
	() =>
		new Promise((resolve) => {
			const req = indexedDB.deleteDatabase('flights-cache');
			req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined);
		})
);

const cold = await search('cold cache');
console.log(`\n(waiting ${GAP_BETWEEN_RUNS_MS / 1000}s before the warm run, to stay welcome)`);
await page.waitForTimeout(GAP_BETWEEN_RUNS_MS);
const warm = await search('same search again, warm cache');

console.log(`\n### ${base}  ${query}`);
console.log(`### cold  total=${cold.total} distinct=${cold.distinct} repeats=${cold.repeats} reversed=${cold.reversed}/${cold.pairs} non200=${cold.failures} burst=${cold.biggestBurst}`);
console.log(`### warm  total=${warm.total} distinct=${warm.distinct} repeats=${warm.repeats} reversed=${warm.reversed}/${warm.pairs} non200=${warm.failures} burst=${warm.biggestBurst}`);
await browser.close();
