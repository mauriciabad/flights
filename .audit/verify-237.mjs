import { chromium } from '@playwright/test';
import { newProbeContext } from '../tools/probe-browser.mjs';

const URL =
	'https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const show = (label, ok, detail) =>
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);

async function run({ break503 }) {
	const browser = await chromium.launch();
	const context = await newProbeContext(browser);
	if (break503) {
		await context.route('**://api.m.hostelworld.com/**', (route) =>
			route.fulfill({
				status: 503,
				contentType: 'text/html',
				body: '<html><head><title>503 Service Unavailable</title></head><body><h1>503 Service Unavailable</h1></body></html>',
			})
		);
	}
	const page = await context.newPage();
	await page.goto(URL, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(55000);
	const opener = page.getByRole('button', { name: /show details|details|expand/i }).first();
	if (await opener.count()) {
		await opener.click();
		await page.waitForTimeout(4000);
	}
	// The status quote and "nothing is known" live inside the stopover fold, one click
	// below the expanded panel. The first version of this probe stopped at the panel and
	// reported two false regressions against a PR that was correct.
	await page.evaluate(() => {
		for (const d of document.querySelectorAll('details')) d.open = true;
	});
	for (const name of [/stopover/i, /stay|bed/i, /why|reason/i]) {
		const b = page.getByRole('button', { name }).first();
		if (await b.count()) {
			await b.click().catch(() => {});
			await page.waitForTimeout(1500);
		}
	}
	await page.waitForTimeout(2000);
	const text = await page.evaluate(() => document.body.innerText);
	await browser.close();
	return text;
}

console.log('=== Hostelworld forced to 503 ===');
const broken = await run({ break503: true });

const fabricated = /had nothing near \w+ for these dates/i.test(broken);
show('#203 no fabricated "had nothing near X" claim', !fabricated);

const quotesStatus = /503/.test(broken);
show('#191 the provider status appears verbatim', quotesStatus);

const namesProvider = /hostelworld/i.test(broken);
show('#191 the provider is named', namesProvider);

const nothingKnown = /nothing is known about beds/i.test(broken);
show('#203 says what it does not know', nothingKnown);

// Count only sentences about a BED. The bare phrase "not priced" also matches
// "Ground, 2 rides not priced", which is a claim about ground transport, not about a
// bed. .audit/check-predicate.sh carries the same warning after the same mistake.
const bedLines = broken
	.split('\n')
	.map((l) => l.trim())
	.filter((l) => /bed|stay/i.test(l) && /not priced|no bed|unpriced|floor/i.test(l))
	.filter((l) => !/ground|ride/i.test(l));
show('#185 five or fewer bed announcements', bedLines.length <= 5, `${bedLines.length}: ${bedLines.join(' / ')}`);

console.log('\n=== Hostelworld healthy ===');
const healthy = await run({ break503: false });
const priced = /€\s?\d/.test(healthy) && /\d+ of \d+ itiner/i.test(healthy);
show('happy path still prices a trip', priced, (healthy.match(/\d+ of \d+ itiner\w+/) || [''])[0]);
const stillFabricates = /had nothing near \w+ for these dates/i.test(healthy);
show('happy path makes no absence claim', !stillFabricates);
