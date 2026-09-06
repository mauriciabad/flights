#!/usr/bin/env node
/**
 * Every surface of the live app, checked in one run.
 *
 * The owner asked for this as a final task: "make sure prod works well on everything".
 * It is a tool rather than a transcript because a check you can re-run outlives a report.
 *
 * Two rules it holds itself to, both learned the hard way on 2026-09-05.
 *
 * ASSERT THAT YOU REACHED THE STATE, NOT ONLY WHAT YOU SAW. A probe that fails to click
 * produces output identical to a pass. Six checks that night were wrong for that reason,
 * three of them asserting against a screen that could never have shown the thing. So every
 * check here reports `reached` separately from `ok`, and a check that could not reach its
 * state prints SKIP with the reason, never PASS.
 *
 * NEVER REPORT A NUMBER FROM A MOCK. If any fixture marker from tests/e2e/fixtures/markers.json
 * appears in the page, the whole run aborts. An agent once reported "BVC to LGW to PFO, EUR 238"
 * off route handlers another agent had left armed in a shared browser.
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { newProbeContext } from './probe-browser.mjs';

const BASE = process.argv[2] ?? 'https://flights.mauri.app';
const TRIP = '/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const markers = (() => {
	try {
		return Object.values(JSON.parse(readFileSync('tests/e2e/fixtures/markers.json', 'utf8')))
			.flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v ?? {})))
			.filter((v) => typeof v === 'string' && v.length > 3);
	} catch {
		return ['FIXTURE', 'FIXTURELAND', 'ZZ0000', '9111.11'];
	}
})();

const results = [];
const record = (surface, name, reached, ok, detail) =>
	results.push({ surface, name, reached, ok, detail: detail ?? '' });

const settle = (page, ms) => page.waitForTimeout(ms);

async function withPage(fn, { width = 1280, height = 900, scheme = 'light' } = {}) {
	const browser = await chromium.launch();
	const context = await newProbeContext(browser, {
		viewport: { width, height },
		colorScheme: scheme
	});
	const page = await context.newPage();
	const errors = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
	try {
		return await fn(page, errors);
	} finally {
		await browser.close();
	}
}

function assertNoFixtures(text, where) {
	const hit = markers.find((m) => text.includes(m));
	if (hit) {
		console.log(`\n!!! MEASUREMENT INVALID: fixture marker ${JSON.stringify(hit)} found in ${where}.`);
		console.log('!!! Nothing in this run is evidence about production. Aborting.');
		process.exit(2);
	}
}

// ---- the home and search screen -------------------------------------------------
await withPage(async (page, errors) => {
	await page.goto(BASE, { waitUntil: 'domcontentloaded' });
	await settle(page, 4000);
	const text = await page.evaluate(() => document.body.innerText);
	assertNoFixtures(text, 'the home page');

	record('home', 'page renders', true, text.length > 200, `${text.length} chars`);

	const from = page.getByRole('combobox').first();
	const reachedSearch = (await from.count()) > 0;
	let found = '';
	if (reachedSearch) {
		await from.fill('Barcelona');
		await settle(page, 3500);
		found = (await page.evaluate(() => document.body.innerText)).match(/BCN|Barcelona[^\n]*/)?.[0] ?? '';
	}
	record('home', 'airport search offers a match', reachedSearch, /BCN|Barcelona/.test(found), found.slice(0, 60));
	record('home', 'no console errors', true, errors.length === 0, errors.slice(0, 2).join(' | '));
});

// ---- results, the acceptance trip -----------------------------------------------
const resultsText = await withPage(async (page, errors) => {
	await page.goto(BASE + TRIP, { waitUntil: 'domcontentloaded' });
	await settle(page, 70000);
	const text = await page.evaluate(() => document.body.innerText);
	assertNoFixtures(text, 'the results page');

	const count = text.match(/(\d+) of (\d+) itiner\w+/);
	record('results', 'itineraries returned', Boolean(count), Number(count?.[1] ?? 0) >= 1, count?.[0] ?? 'none');

	const cities = await page.evaluate(() =>
		[...document.querySelectorAll('button')]
			.map((b) => (b.innerText || '').trim().replace(/\s+/g, ' '))
			.filter((t) => /^[A-Z][a-zA-Z ]+ [A-Z]{3} \(\d+\)$/.test(t))
	);
	record('results', 'connection cities offered', cities.length > 0, cities.length >= 2, cities.join(', '));

	record('results', 'a total is named', true, /getting there/i.test(text));
	// Wording checked against production on 2026-09-06: the receipt reads "Ride to hotel"
	// and "Rides from and to hotel". The previous matcher wanted "Ground, 2 rides", which
	// this UI has never said, so this check had only ever reported a failure of itself.
	record('results', 'ground legs are accounted for', true, /rides? (to|from and to) hotel/i.test(text),
		(text.match(/Rides? (?:to|from and to) hotel/gi) ?? []).join(' | '));
	record('results', 'no padded am\/pm clock', true, !/\b0\d:\d\d\s?(am|pm)/i.test(text));
	record('results', 'no "Nd 24h" duration', true, !/\b\d+d\s+24h\b/.test(text));
	record('results', 'no negative layover', true, !/-\d+ minutes between/i.test(text));
	record('results', 'no rating out of 5', true, !/rated [\d.]+\/5\b/i.test(text));
	record('results', 'no fabricated absence claim', true, !/had nothing near \w+ for these dates/i.test(text));

	const osrm = errors.filter((e) => /CONNECTION_RESET|429/.test(e)).length;
	record('results', 'no console errors', true, errors.length === 0,
		errors.length ? `${errors.length} (${osrm} routing) e.g. ${errors[0]?.slice(0, 60)}` : '');
	return text;
});

// ---- the detail panel ------------------------------------------------------------
// The opener is "show the full timeline". It was /show details/i until 2026-09-06, a
// button #278 deleted, so every check below reported SKIP and nobody read the word.
await withPage(async (page) => {
	await page.goto(BASE + TRIP, { waitUntil: 'domcontentloaded' });
	await settle(page, 70000);
	const opener = page.getByRole('button', { name: /show the full timeline/i }).first();
	const reached = (await opener.count()) > 0;
	if (reached) {
		await opener.click();
		await settle(page, 6000);
	}
	const text = reached ? await page.evaluate(() => document.body.innerText) : '';
	if (reached) assertNoFixtures(text, 'the detail panel');

	record('detail', 'panel opens', reached, reached);
	record('detail', 'free time reads in days', reached,
		/(No full days|\d+ full days?:)/.test(text), (text.match(/(No full days|\d+ full days?:[^\n]*)/) ?? [''])[0]);
	record('detail', 'edge lines carry real times', reached,
		/\w{3} \d{1,2} (from|until) \d{1,2}(:\d\d)?(am|pm)/.test(text),
		(text.match(/\w{3} \d{1,2} (from|until) \d{1,2}(:\d\d)?(am|pm)/g) ?? []).slice(0, 2).join(' | '));
	record('detail', 'timeline lists the journey', reached, /airport wait|stopover|flight/i.test(text));

	// A ground-leg preview fills its whole box as land when land.ts cannot resolve a coast
	// into a window that small. Issue #408: the owner asked for water. A box that is four
	// corners and a close is the solid fill; anything else is a drawn coast.
	const previews = reached
		? await page.evaluate(() => {
				const paths = [...document.querySelectorAll('.ground-leg .rp-land')];
				const wholeBox = (d) => /^M0 0L[\d.]+ 0L[\d.]+ [\d.]+L0 [\d.]+Z$/.test(d ?? '');
				return { total: paths.length, solid: paths.filter((p) => wholeBox(p.getAttribute('d'))).length };
			})
		: { total: 0, solid: 0 };
	record('detail', 'ground previews draw a coast, not a grey box', reached && previews.total > 0,
		previews.total > 0 && previews.solid === 0, `${previews.solid} of ${previews.total} filled solid`);

	// Opening a stopover step is what mounts the stay picker. The bed facts live there and
	// nowhere else, which is why asserting them against the results page always failed.
	const stopover = page.getByRole('button', { name: /^Stopover,/i }).first();
	const atPicker = reached && (await stopover.count()) > 0;
	if (atPicker) {
		await stopover.click();
		await settle(page, 8000);
	}
	const rows = atPicker
		? await page.evaluate(() => [...document.querySelectorAll('.alt-card')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()))
		: [];
	const picker = rows.join(' | ');

	record('picker', 'stay rows render', atPicker, rows.length > 0, `${rows.length} rows`);
	record('picker', 'a bed states its distance', atPicker && rows.length > 0,
		/km from airport|m from centre/i.test(picker),
		(picker.match(/[\d.]+ (?:km|m) from (?:airport|centre)/i) ?? [''])[0]);
	// Issue #405, and named for exactly what it tests. It asserts that a duration appears
	// on a stay row at all, which today it does not. It does NOT check that there is one
	// per mode, or that an icon sits beside it, because the markup for that is not built
	// and a matcher written against a guess is how the checks above drifted in the first
	// place. Tighten this once #405 has shipped and there is real markup to name.
	record('picker', 'a bed row states a duration', atPicker && rows.length > 0,
		/\d+\s?(min|h)\b/.test(picker), (picker.match(/[\d]+\s?(?:min|h)\b/) ?? [''])[0]);
	// Issue #406.
	// Scoped to the stay list's own container, not the document. Unscoped, this matched
	// "Sort 3 trips into place" on the results page behind the panel and passed while the
	// stay list had no control at all. A flattened match from the wrong element is this
	// repo's most repeated instrument failure.
	const sorters = atPicker
		? await page.evaluate(() => {
				const list = document.querySelector('.stay-alternatives');
				if (!list) return [];
				return [...list.querySelectorAll('button, select, [role="radio"], [role="tab"], [role="radiogroup"]')]
					.map((e) => (e.innerText || e.ariaLabel || '').replace(/\s+/g, ' ').trim())
					.filter((t) => /sort|recommended|nearest|cheapest|distance|walk|transit/i.test(t));
			})
		: [];
	record('picker', 'the stay list offers a sort key', atPicker, sorters.length > 0, sorters.slice(0, 4).join(' | '));
});

// ---- settings and key handling ---------------------------------------------------
await withPage(async (page, errors) => {
	await page.goto(`${BASE}/settings/`, { waitUntil: 'domcontentloaded' });
	await settle(page, 5000);
	const text = await page.evaluate(() => document.body.innerText);
	assertNoFixtures(text, 'settings');

	record('settings', 'page renders', true, text.length > 200);
	record('settings', 'offers provider keys', true, /key/i.test(text));
	record('settings', 'offers a currency', true, /currenc/i.test(text));
	record('settings', 'offers a clock format', true, /24|am\/pm|clock/i.test(text));

	const thirdParty = await page.evaluate(() =>
		[...document.querySelectorAll('script[src]')]
			.map((s) => s.getAttribute('src'))
			.filter((s) => s && !s.startsWith('/') && !s.startsWith(location.origin))
	);
	record('settings', 'no third-party script can read localStorage', true, thirdParty.length === 0,
		thirdParty.join(', '));
	record('settings', 'no console errors', true, errors.length === 0, errors.slice(0, 2).join(' | '));
});

// ---- a phone, and the dark scheme ------------------------------------------------
for (const [label, opts] of [
	['phone 375 dark', { width: 375, height: 812, scheme: 'dark' }],
	['desktop 1280 dark', { width: 1280, height: 900, scheme: 'dark' }]
]) {
	await withPage(async (page, errors) => {
		await page.goto(BASE + TRIP, { waitUntil: 'domcontentloaded' });
		await settle(page, 70000);
		const text = await page.evaluate(() => document.body.innerText);
		assertNoFixtures(text, label);
		const count = text.match(/(\d+) of (\d+) itiner\w+/);
		record(label, 'itineraries returned', Boolean(count), Number(count?.[1] ?? 0) >= 1, count?.[0] ?? 'none');
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
		);
		record(label, 'no horizontal overflow', true, !overflow);
		record(label, 'no console errors', true, errors.length === 0, errors.slice(0, 2).join(' | '));
	}, opts);
}

// ---- report ----------------------------------------------------------------------
console.log(`\nProduction check of ${BASE}\n`);
let bad = 0;
let skipped = 0;
for (const r of results) {
	const tag = !r.reached ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
	if (tag === 'FAIL') bad++;
	if (tag === 'SKIP') skipped++;
	console.log(`${tag}  ${r.surface.padEnd(18)} ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}
console.log(`\n${results.length - bad - skipped} passed, ${bad} failed, ${skipped} could not be reached.`);
if (skipped) console.log('A SKIP is not a pass. It means the check never got to the thing it asserts.');

// A skip has to be non-zero too, and it took until 2026-09-06 to notice that it was not.
// This file printed "A SKIP is not a pass" and then returned success on the next line. Run
// that morning it reported four unreachable checks, said the sentence, and exited 0, so any
// caller reading the exit code learned that production was fine. The sentence was doing all
// the work and nothing was reading it.
//
// 1 means a check failed, 3 means a check never reached its subject. Different problems: the
// first is the app, the second is this file. 2 is taken by a fixture leak, which is worse
// than both because it means the run was never evidence at all.
process.exit(bad > 0 ? 1 : skipped > 0 ? 3 : 0);
