import { chromium } from '@playwright/test';
import { newProbeContext } from '../tools/probe-browser.mjs';

const TARGET =
	'https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();
await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(60000);
const opener = page.getByRole('button', { name: /show details/i }).first();
if (await opener.count()) {
	await opener.click();
	await page.waitForTimeout(5000);
}
const text = await page.evaluate(() => document.body.innerText);
await browser.close();

const show = (label, ok, detail) =>
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);

const count = (text.match(/\d+ of \d+ itiner\w+/) || ['none'])[0];
show('#255 four itineraries (known regression)', /^[4-9]/.test(count), count);

const badScale = text.match(/rated [\d.]+\/5\b/gi) || [];
show('#245 no rating printed out of 5', badScale.length === 0, badScale.join(', '));
const goodScale = text.match(/rated [\d.]+\/10\b/gi) || [];
show('#245 rating on a real scale', goodScale.length > 0, goodScale.slice(0, 3).join(', '));

const zeroRating = /rated 0(\.0)?\/\d+/i.test(text);
show('#245 no bare zero rating', !zeroRating);

const negative = text.match(/-\d+ minutes between/gi) || [];
show('#247 no negative layover minutes', negative.length === 0, negative.join(', '));

const distance = text.match(/[\d.]+\s?km from (centre|the airport)/gi) || [];
show('#219/#198 bed states a distance', distance.length > 0, distance.slice(0, 3).join(' | '));

const getting = /getting there/i.test(text);
show('#225 the total is named', getting);

const band = /prices seen in this browser/i.test(text);
show('#232 price band disclaims its source', band, band ? '' : '(may be below the 14-date floor)');
