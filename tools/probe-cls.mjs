/**
 * Cumulative Layout Shift on one results URL, measured the way issue #314 measured it.
 *
 *   node tools/probe-cls.mjs --url 'https://flights.mauri.app/results/?...' --viewport phone
 *   node tools/probe-cls.mjs --url 'http://127.0.0.1:4319/results/?...' --viewport desktop
 *
 * Its own Chromium and its own fresh context, never the shared Playwright MCP browser
 * (AGENTS.md, "Testing the live app without lying to yourself"). A fresh context starts
 * with no service worker, no Cache Storage and no `flights-cache` IndexedDB, which is the
 * cold load the issue's numbers were taken on.
 *
 * It reads the real free providers. Ryanair, OSRM and Transitous cost nothing, and
 * `runSearch` has no path to a metered one, so a run spends no quota. It also means the
 * timing is real: the shifts this reports land when a provider answers, not when a mock
 * decides to. `tests/e2e/results-cls.spec.ts` is the deterministic half of this pair.
 *
 * What it prints is the number, then the shifts that make it up with the element each one
 * moved, then a height timeline. The last two are what turn "CLS went up" into a diff.
 */
import process from 'node:process';
import { chromium } from '@playwright/test';

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : process.argv[index + 1];
}

const url = arg('url');
const viewportName = arg('viewport', 'phone');
const waitMs = Number(arg('wait', 45000));
const sampleMs = Number(arg('sample', 2000));
/** 4x is Lighthouse's mobile setting. Off for desktop, which is what the issue's 1280
 * numbers were taken on. */
const cpuThrottle = Number(arg('cpu', viewportName === 'phone' ? 4 : 1));

if (!url) {
	console.error('usage: node tools/probe-cls.mjs --url <results url> [--viewport phone|desktop]');
	process.exit(2);
}

/**
 * `viewport`, not a bare `width`/`height`. Playwright silently ignores unknown context
 * options, so an earlier version of this file measured every run at the default 1280x720
 * while printing "375x812" over the numbers. The label agreeing with the measurement is
 * the whole point of a probe.
 */
const VIEWPORTS = {
	phone: {
		viewport: { width: 375, height: 812 },
		deviceScaleFactor: 3,
		isMobile: true,
		hasTouch: true
	},
	desktop: {
		viewport: { width: 1280, height: 900 },
		deviceScaleFactor: 1,
		isMobile: false,
		hasTouch: false
	}
};
const profile = VIEWPORTS[viewportName];
if (!profile) {
	console.error(`unknown viewport "${viewportName}", expected phone or desktop`);
	process.exit(2);
}

/**
 * Installed before any of the app's own script runs, so `buffered: true` has the whole
 * navigation to replay rather than whatever happened after the probe got a word in.
 * `hadRecentInput` is the browser's own 500ms exclusion; this probe never touches the
 * page, so nothing is excluded for the wrong reason.
 */
const OBSERVER = () => {
	const shifts = [];
	let total = 0;
	const name = (node) => {
		const classes = String(node.getAttribute?.('class') ?? '')
			.split(/\s+/)
			.filter((token) => token && !token.startsWith('svelte-'))
			.slice(0, 2)
			.map((token) => `.${token}`)
			.join('');
		return `${node.tagName.toLowerCase()}${classes}`;
	};
	/** The element alone is rarely enough to name what moved: half the entries on this page
	 * report a bare `li`. Three ancestors say which list it is in. */
	const describe = (node) => {
		if (!node || node.nodeType !== 1) return 'unknown';
		const chain = [];
		for (let at = node; at && at.tagName !== 'BODY' && chain.length < 4; at = at.parentElement) {
			chain.unshift(name(at));
		}
		return chain.join(' > ');
	};
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (entry.hadRecentInput) continue;
			total += entry.value;
			shifts.push({
				value: entry.value,
				at: Math.round(entry.startTime),
				sources: (entry.sources ?? []).map((source) => ({
					node: describe(source.node),
					// The two rects are the whole story of one shift: what moved, from where,
					// to where. A total cannot tell a 10px nudge of everything from a 450px
					// drop of one card, and those want opposite fixes.
					from: `${Math.round(source.previousRect.y)}+${Math.round(source.previousRect.height)}`,
					to: `${Math.round(source.currentRect.y)}+${Math.round(source.currentRect.height)}`
				}))
			});
		}
	}).observe({ type: 'layout-shift', buffered: true });
	Object.defineProperty(window, '__cls', { get: () => ({ total, shifts }) });
};

const browser = await chromium.launch();
const context = await browser.newContext({
	...profile,
	// Same override probe-results.mjs uses and for the same reason: Kiwi's public endpoint
	// answers "HeadlessChrome" with a 403, so the default UA measures a page that lost a
	// provider no real visitor loses.
	userAgent:
		viewportName === 'phone'
			? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
			: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
});
await context.addInitScript(OBSERVER);
const page = await context.newPage();

if (cpuThrottle > 1) {
	const session = await context.newCDPSession(page);
	await session.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
}

const samples = [];
await page.goto(url, { waitUntil: 'commit' });

const started = Date.now();
while (Date.now() - started < waitMs) {
	await page.waitForTimeout(sampleMs);
	samples.push(
		await page.evaluate(() => ({
			at: Math.round(performance.now()),
			height: Math.round(
				document.querySelector('.results-page')?.getBoundingClientRect().height ?? 0
			),
			cards: document.querySelectorAll('.result-card').length,
			slots: document.querySelectorAll('.results-list > li').length,
			context: Math.round(
				document.querySelector('.results-context')?.getBoundingClientRect().height ?? 0
			),
			/** Where the list starts. Everything that moves this moves every card on screen
			 * with it, which is the shift worth the most and the hardest to see in a total. */
			listTop: Math.round(
				document.querySelector('.results-list')?.getBoundingClientRect().top ?? 0
			)
		}))
	);
}

const { total, shifts } = await page.evaluate(() => window.__cls);

console.log(`\n${viewportName} ${profile.viewport.width}x${profile.viewport.height}, cpu ${cpuThrottle}x, ${waitMs}ms`);
console.log(url);
console.log(`\nCLS ${total.toFixed(4)}   (good <= 0.10, poor > 0.25)`);

console.log(`\n${shifts.length} shifts:`);
for (const shift of shifts.filter((s) => s.value >= 0.001).sort((a, b) => b.value - a.value)) {
	console.log(`  ${shift.value.toFixed(4)}  at ${String(shift.at).padStart(6)}ms`);
	for (const source of shift.sources) {
		console.log(`      y${source.from} -> y${source.to}   ${source.node}`);
	}
}
const negligible = shifts.filter((s) => s.value < 0.001).length;
if (negligible > 0) console.log(`  (${negligible} more under 0.001)`);

console.log('\n  t      height  cards  slots  context  listTop');
for (const sample of samples) {
	console.log(
		`  ${String(Math.round(sample.at / 1000) + 's').padEnd(5)}  ${String(sample.height).padStart(6)}  ${String(sample.cards).padStart(5)}  ${String(sample.slots).padStart(5)}  ${String(sample.context).padStart(7)}  ${String(sample.listTop).padStart(6)}`
	);
}

await browser.close();
