/**
 * Issue #289. Watches a result card's "fetched N ago" footer while a refetch is actually
 * in flight, so the label and the requests behind it are read off the same clock.
 *
 * The reading that filed the issue came from one load, and one load cannot tell a label
 * that never moves from a label that moved before the sampler started. So this samples the
 * footer, the search status, `aria-busy` and the live regions every 150 ms from before the
 * first script runs, and prints every distinct footer string with the millisecond it first
 * appeared, next to the provider responses that landed in the same window.
 *
 *   node tools/probe-card-age.mjs --url 'http://127.0.0.1:41289/results/?...' --age-hours 3
 *
 * How the two ages are forced apart: after a cold search, every cache entry is backdated.
 * Flight and stay entries go past their own TTL (15 min for Kiwi offers, 60 min for Ryanair
 * fares, 5 min for Transitous) so the reload refetches them, while OSRM road routes are
 * backdated `--age-hours` and stay well inside their 30-day TTL, so nothing refetches them
 * and their `fetchedAt` keeps the old stamp. That is the shape of every warm reload in
 * production, forced rather than waited for.
 */
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? fallback : args[at + 1];
};

const url = flag('url', 'http://127.0.0.1:41289/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
const ageHours = Number(flag('age-hours', 3));
const sampleMs = Number(flag('sample-ms', 150));
const watchMs = Number(flag('watch-ms', 25_000));
const runs = Number(flag('runs', 2));

const SAMPLER = (intervalMs) => {
	const started = Date.now();
	window.__samples = [];
	const read = () => {
		const cards = Array.from(document.querySelectorAll('.result-card'));
		return {
			t: Date.now() - started,
			footers: cards.map((card) => card.querySelector('.provenance-source')?.textContent?.trim() ?? ''),
			cardClasses: cards.map((card) => card.className),
			status: document.querySelector('.results-subhead')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
			busy: document.querySelectorAll('[aria-busy="true"]').length,
			live: Array.from(document.querySelectorAll('[aria-live]'))
				.map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
				.filter(Boolean)
		};
	};
	setInterval(() => window.__samples.push(read()), intervalMs);
	read();
};

const readCache = async (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				const open = indexedDB.open('flights-cache', 1);
				open.onsuccess = () => {
					const tx = open.result.transaction('entries', 'readonly');
					const all = tx.objectStore('entries').getAll();
					all.onsuccess = () =>
						resolve(
							all.result.map((entry) => ({
								key: entry.key,
								providerId: entry.providerId,
								ageMinutes: Math.round((Date.now() - entry.storedAt) / 60_000),
								ttlMinutes: Math.round(entry.ttlMs / 60_000)
							}))
						);
					all.onerror = () => resolve([]);
				};
				open.onerror = () => resolve([]);
			})
	);

/** Backdates every entry. Road routes get `ageHours`; everything else goes one minute past
 *  its own TTL, which is the smallest push that guarantees a refetch. */
const backdate = async (page, hours) =>
	page.evaluate(
		(hoursBack) =>
			new Promise((resolve) => {
				const open = indexedDB.open('flights-cache', 1);
				open.onsuccess = () => {
					const tx = open.result.transaction('entries', 'readwrite');
					const store = tx.objectStore('entries');
					const all = store.getAll();
					all.onsuccess = () => {
						let moved = 0;
						for (const entry of all.result) {
							const isRoad = entry.providerId === 'osrm';
							const back = isRoad ? hoursBack * 3_600_000 : entry.ttlMs + 60_000;
							entry.storedAt = Date.now() - back;
							store.put(entry);
							moved += 1;
						}
						tx.oncomplete = () => resolve(moved);
					};
					all.onerror = () => resolve(0);
				};
				open.onerror = () => resolve(0);
			}),
		hours
	);

const settled = async (page, timeout) => {
	await page
		.waitForFunction(() => !/still searching/.test(document.body.innerText), null, { timeout })
		.catch(() => {});
};

const providerHost = (requestUrl) => {
	const host = new URL(requestUrl).host;
	return host.includes('127.0.0.1') || host.includes('localhost') ? undefined : host;
};

async function run(label) {
	const browser = await chromium.launch();
	const context = await newProbeContext(browser);
	const page = await context.newPage();

	const responses = [];
	let clockZero = Date.now();
	page.on('response', (response) => {
		const host = providerHost(response.url());
		if (host) responses.push({ host, at: Date.now() - clockZero, status: response.status() });
	});

	await page.goto(url, { waitUntil: 'domcontentloaded' });
	await settled(page, 40_000);
	const cold = await readCache(page);
	if (cold.length === 0) {
		console.log(`${label}: nothing cached, the search did not reach a provider. Stopping.`);
		await browser.close();
		return;
	}

	const moved = await backdate(page, ageHours);
	console.log(`\n=== ${label} ===`);
	console.log(`cold cache: ${cold.length} entries, backdated ${moved}`);
	for (const provider of [...new Set(cold.map((entry) => entry.providerId))].sort()) {
		const mine = cold.filter((entry) => entry.providerId === provider);
		console.log(`  ${provider}: ${mine.length} entries, ttl ${mine[0].ttlMinutes} min`);
	}

	await page.addInitScript(SAMPLER, sampleMs);
	responses.length = 0;
	clockZero = Date.now();
	await page.reload({ waitUntil: 'domcontentloaded' });
	await settled(page, watchMs);
	await page.waitForTimeout(watchMs);

	const samples = await page.evaluate(() => window.__samples ?? []);
	const first = new Map();
	for (const sample of samples) {
		for (const footer of sample.footers) if (footer && !first.has(footer)) first.set(footer, sample.t);
	}

	console.log('footer strings, in the order they first appeared:');
	for (const [footer, at] of first) console.log(`  +${String(at).padStart(6)} ms  ${footer}`);

	const byHost = new Map();
	for (const response of responses) {
		const seen = byHost.get(response.host) ?? { count: 0, last: 0 };
		byHost.set(response.host, { count: seen.count + 1, last: Math.max(seen.last, response.at) });
	}
	console.log('provider responses on the reload:');
	for (const [host, seen] of [...byHost].sort((a, b) => b[1].last - a[1].last)) {
		console.log(`  ${host}: ${seen.count}, last at +${seen.last} ms`);
	}

	const busySamples = samples.filter((sample) => sample.busy > 0).length;
	const searching = samples.filter((sample) => /still searching/.test(sample.status));
	console.log(
		`aria-busy in ${busySamples}/${samples.length} samples; "still searching" cleared at +${
			searching.length > 0 ? searching[searching.length - 1].t + sampleMs : 0
		} ms`
	);

	const warm = await readCache(page);
	console.log('cache age after the reload, oldest entry per provider:');
	for (const provider of [...new Set(warm.map((entry) => entry.providerId))].sort()) {
		const oldest = Math.max(...warm.filter((entry) => entry.providerId === provider).map((entry) => entry.ageMinutes));
		console.log(`  ${provider}: ${oldest} min`);
	}

	await browser.close();
}

for (let index = 1; index <= runs; index += 1) await run(`run ${index}`);
