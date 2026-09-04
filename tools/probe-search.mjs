/**
 * Types a query into the live search form's airport field and prints the dropdown.
 * Its own Chromium, so no other agent's tab can move underneath it (AGENTS.md).
 *
 *   node tools/probe-search.mjs Paris Barcelona Oslo
 */
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const queries = process.argv.slice(2);
const origin = process.env.LAYOVER_ORIGIN ?? 'https://flights.mauri.app';

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();
await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });

const field = page.getByRole('combobox').first();
await field.waitFor({ timeout: 20000 });

for (const q of queries) {
	await field.fill('');
	await field.fill(q);
	await page.waitForTimeout(600);
	const options = await page.getByRole('option').allInnerTexts();
	const flat = options.map((o) => o.replace(/\s+/g, ' ').trim());
	console.log(`${q.padEnd(14)} -> ${flat.length ? flat.join(' | ') : '(none)'}`);
}

await browser.close();
