import { chromium } from '@playwright/test';
import { newProbeContext } from '../tools/probe-browser.mjs';

const URL =
	'https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();
const errors = [];
const failed = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 90)}`));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(45000);

console.log('--- console errors, deduped ---');
for (const e of [...new Set(errors)]) console.log(e.slice(0, 200));
console.log('--- failed requests by host ---');
const byHost = {};
for (const f of failed) {
	const host = (f.match(/https?:\/\/([^/]+)/) || [, 'other'])[1];
	byHost[host] = (byHost[host] ?? 0) + 1;
}
console.log(JSON.stringify(byHost, null, 1));
console.log('--- non-OSRM failures ---');
for (const f of failed.filter((x) => !/openstreetmap/.test(x))) console.log(f);
await browser.close();
