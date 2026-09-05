import { chromium } from '@playwright/test';
import { newProbeContext } from '../tools/probe-browser.mjs';

const URL =
	'https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(60000);

const opener = page.getByRole('button', { name: /show details|details|expand/i }).first();
if (await opener.count()) {
	await opener.click();
	await page.waitForTimeout(4000);
}

const show = (label, ok, detail) =>
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);

const outline = await page.evaluate(() =>
	[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
		level: Number(h.tagName[1]),
		text: h.innerText.trim().slice(0, 40),
	}))
);
const jumps = [];
let previous = 0;
for (const h of outline) {
	if (previous && h.level > previous + 1) jumps.push(`h${previous} -> h${h.level} "${h.text}"`);
	previous = h.level;
}
show('#236 no heading-level jump', jumps.length === 0, jumps.slice(0, 4).join(' | '));

const blocks = await page.evaluate(() => {
	const found = [];
	for (const el of document.querySelectorAll('section,div')) {
		const t = el.innerText || '';
		if (/(No full days|\d+ full days?:)/.test(t) && /(from|until) \d/.test(t) && t.length < 700) {
			found.push(t.trim());
		}
	}
	return found.sort((a, b) => a.length - b.length).slice(0, 1);
});

if (blocks.length === 0) {
	show('#236 stopover block found', false, 'no block matched');
} else {
	const block = blocks[0];
	console.log('--- block as rendered ---\n' + block + '\n---');
	const transport = /from the airport|nothing routed|no bed priced|walk|bus|metro|taxi|drive|public transport|price not available/i.test(block);
	show('#236 transport line always present', transport);
	const rate = /\d+ nights?, €[\d.]+\/night/i.test(block) || /no bed/i.test(block);
	show('#228 bed line with nightly rate', rate);
}

const badDuration = (await page.evaluate(() => document.body.innerText)).match(/\b\d+d\s+24h\b/g) || [];
show('#217 still no "Nd 24h"', badDuration.length === 0);

const padded = (await page.evaluate(() => document.body.innerText)).match(/\b0\d:\d\d\s?(am|pm)/gi) || [];
show('#229 still no padded am/pm', padded.length === 0);

const osrm = errors.filter((e) => /CONNECTION_RESET/.test(e)).length;
show('console errors other than OSRM', errors.length - osrm === 0, `${osrm} OSRM resets, ${errors.length - osrm} other`);

await browser.close();
