/**
 * Loads a results URL in its own Chromium and reports what the page says plus what the
 * network actually did. The request log is usually the half the screen leaves out.
 *
 *   node tools/probe-results.mjs 'https://flights.mauri.app/results/?...'
 */
import { chromium } from '@playwright/test';

const url = process.argv[2];
const waitMs = Number(process.argv[3] ?? 90000);

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const responses = [];
const failed = [];
page.on('response', (r) => { const u = r.url(); if (!u.includes('flights.mauri.app') && !u.startsWith('data:')) responses.push({ status: r.status(), url: u }); });
page.on('requestfailed', (r) => failed.push({ url: r.url().slice(0, 130), err: r.failure()?.errorText }));
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 250)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 400)));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
const deadline = Date.now() + waitMs;
let text = '';
while (Date.now() < deadline) {
	text = await page.evaluate(() => document.body.innerText);
	if (!/still searching/.test(text)) break;
	await page.waitForTimeout(2000);
}
console.log('COUNT:', (text.match(/\d+ of \d+ itiner\w+/) || ['(none)'])[0], '| stillSearching:', /still searching/.test(text));
const i = text.indexOf('PROVIDERS THAT ANSWERED');
console.log('--- what the page says ---\n' + (i >= 0 ? text.slice(i, i + 600) : text.slice(0, 600)));
const byHost = {};
for (const r of responses) { const h = new URL(r.url).host; byHost[h] ??= {}; byHost[h][r.status] = (byHost[h][r.status] ?? 0) + 1; }
console.log('--- what the network did ---\n' + JSON.stringify(byHost, null, 1));
console.log('--- non-2xx samples ---\n' + responses.filter((r) => r.status >= 400).slice(0, 6).map((b) => `${b.status} ${b.url.slice(0, 110)}`).join('\n'));
if (failed.length) console.log('--- blocked/failed ---\n' + JSON.stringify(failed.slice(0, 8), null, 1));
if (errors.length) console.log('--- console errors ---\n' + [...new Set(errors)].slice(0, 8).join('\n'));
await browser.close();
