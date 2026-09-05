/**
 * Issue #358: how long after the results heading appears does the search actually get
 * filed into `localStorage`?
 *
 *   node tools/probe-history-write-timing.mjs <baseUrl> [runs]
 *
 * `search-to-results.spec.ts` waited for the `<h1>` to say BCN and then navigated away. If
 * the history write had not landed by then it never landed at all, and the spec failed
 * looking for a link that was never written. This measures the gap between the two events
 * on the page's own clock, so the answer is a number rather than a theory, and prints the
 * airports dataset chunk's own `responseEnd` beside it, because that download is what the
 * write used to wait for.
 *
 * It only watches. Holding that chunk back to prove the causation is interception, and
 * `guard.spec.ts` forbids a probe from doing anything that could answer a request — an
 * instrument that can serve a fixture cannot be trusted to detect one. The held-back
 * version of this measurement is a test: "a search is filed without waiting for the
 * airport dataset" in `tests/e2e/search-to-results.spec.ts`.
 *
 * A fresh context has no keys in `localStorage`, so no metered provider is ever asked
 * anything and this costs nothing to run.
 */
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4173';
const runs = Number(process.argv[3] ?? 10);
const target = `${baseUrl}/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL`;

const browser = await chromium.launch();
const gaps = [];

for (let run = 0; run < runs; run++) {
	// A context per run: the dataset chunk is served from cache on a second load in the
	// same one, which is exactly the wait being measured.
	const context = await browser.newContext({
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
	});
	await context.addInitScript(() => {
		const marks = { headingAt: null, writeAt: null };
		window.__historyProbe = marks;
		const setItem = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key === 'flights.searchHistory.v1' && marks.writeAt === null) {
				marks.writeAt = performance.now();
			}
			return setItem.call(this, key, value);
		};
		const seeHeading = () => {
			if (marks.headingAt !== null) return;
			const h1 = document.querySelector('h1');
			if (h1?.textContent?.includes('BCN')) marks.headingAt = performance.now();
		};
		new MutationObserver(seeHeading).observe(document, {
			subtree: true,
			childList: true,
			characterData: true
		});
		document.addEventListener('DOMContentLoaded', seeHeading);
	});

	const page = await context.newPage();
	await page.goto(target);
	await page.waitForFunction(() => window.__historyProbe?.headingAt !== null, null, {
		timeout: 30000
	});
	const headingAt = await page.evaluate(() => window.__historyProbe.headingAt);
	let writeAt = null;
	try {
		await page.waitForFunction(() => window.__historyProbe?.writeAt !== null, null, {
			timeout: 30000
		});
		writeAt = await page.evaluate(() => window.__historyProbe.writeAt);
	} catch {
		// left null: the write never happened inside the window
	}
	// Matched on the response body's own first row, since the chunk's name is a content hash.
	const datasetAt = await page.evaluate(async () => {
		for (const entry of performance.getEntriesByType('resource')) {
			if (!/\/chunks\/[^/]+\.js$/.test(entry.name)) continue;
			const head = await fetch(entry.name)
				.then((response) => response.text())
				.then((text) => text.slice(0, 400))
				.catch(() => '');
			if (head.includes('"iataCode"')) return Math.round(entry.responseEnd);
		}
		return null;
	});
	const gap = writeAt === null ? null : writeAt - headingAt;
	gaps.push(gap);
	console.log(
		`run ${run + 1}: heading ${headingAt.toFixed(0)}ms, write ${writeAt === null ? 'never' : writeAt.toFixed(0) + 'ms'}, gap ${gap === null ? 'n/a' : gap.toFixed(0) + 'ms'}, airports dataset done ${datasetAt ?? 'not seen'}ms`
	);
	await context.close();
}

const measured = gaps.filter((gap) => gap !== null).sort((a, b) => a - b);
console.log(
	`\nruns=${runs} gap min ${measured[0]?.toFixed(0)}ms median ${measured[Math.floor(measured.length / 2)]?.toFixed(0)}ms max ${measured.at(-1)?.toFixed(0)}ms never-written ${gaps.length - measured.length}`
);

await browser.close();
