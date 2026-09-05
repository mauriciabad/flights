import { chromium } from '@playwright/test';
import { newProbeContext } from '../tools/probe-browser.mjs';

const URL =
	'https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(60000);

const collapsed = await page.evaluate(() => document.body.innerText);

const opener = page
	.getByRole('button', { name: /show details|details|expand/i })
	.first();
let expandedOk = false;
if (await opener.count()) {
	await opener.click();
	await page.waitForTimeout(4000);
	expandedOk = true;
}
const text = (await page.evaluate(() => document.body.innerText));
console.log(`(card expanded: ${expandedOk})`);

const show = (label, ok, detail) =>
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);

const count = (text.match(/\d+ of \d+ itiner\w+/) || ['(none)'])[0];
show('itineraries on the page', /[1-9]/.test(count), count);

const padded = text.match(/\b0\d:\d\d\s?(am|pm)/gi) || [];
show('#229 no padded am/pm clock', padded.length === 0, padded.slice(0, 5).join(', '));

const ampm = text.match(/\b\d{1,2}(:\d\d)?\s?(am|pm)\b/gi) || [];
show('#229 clocks read as am/pm', ampm.length > 0, `${ampm.length} found, e.g. ${ampm.slice(0, 4).join(', ')}`);

const twentyFour = text.match(/\b([01]\d|2[0-3]):[0-5]\d\b(?!\s?(am|pm))/g) || [];
show('#229 no 24h clock left over', twentyFour.length === 0, twentyFour.slice(0, 5).join(', '));

const badDuration = text.match(/\b\d+d\s+24h\b/g) || [];
show('#217 no "Nd 24h"', badDuration.length === 0, badDuration.join(', '));

const fullDays = text.match(/(No full days|\d+ full days?:[^\n]*)/g) || [];
show('#228 free time counted in days', fullDays.length > 0, fullDays.slice(0, 3).join(' | '));

const edges = text.match(/\w{3} \d{1,2} (from|until) \d{1,2}(:\d\d)?(am|pm)/g) || [];
show('#228 edge lines with real times', edges.length > 0, edges.slice(0, 4).join(' | '));

const editorial = /still counts|too late to count/i.test(text);
show('#228 no explanatory text', !editorial);

const prices = text.match(/€\s?[\d,.]+/g) || [];
const absurd = prices.filter((p) => Number(p.replace(/[^\d.]/g, '')) > 5000);
show('#192 no 100x price on screen', absurd.length === 0, absurd.slice(0, 5).join(', '));

show('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
