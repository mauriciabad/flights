/**
 * Loads a results URL twice in ONE browser context and counts provider requests each
 * time. A working cache means the second load costs far less than the first.
 *
 *   node tools/probe-reload.mjs '<url>'
 */
import { chromium } from '@playwright/test';

const url = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
let count = 0;
page.on('response', (r) => { if (!r.url().includes('flights.mauri.app') && !r.url().startsWith('data:')) count += 1; });

async function load(label) {
	count = 0;
	await page.goto(url, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
	for (let i = 0; i < 40; i++) {
		const t = await page.evaluate(() => document.body.innerText);
		if (!/still searching/.test(t)) break;
		await page.waitForTimeout(2000);
	}
	const text = await page.evaluate(() => document.body.innerText);
	const age = (text.match(/fetched [^\n·]*/i) || ['(no age shown)'])[0].trim();
	console.log(`${label}: ${count} provider requests | ${(text.match(/\d+ of \d+ itiner\w+/) || ['?'])[0]} | ${age}`);
}

await load('first load ');
await load('reload    ');
await browser.close();
