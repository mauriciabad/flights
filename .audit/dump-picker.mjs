import { chromium } from '@playwright/test';
import { newProbeContext } from '../tools/probe-browser.mjs';

const TARGET =
	'https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();
await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(60000);
await page.getByRole('button', { name: /show details/i }).first().click();
await page.waitForTimeout(5000);

const seg = page.locator('[data-segment="outbound-flight"]').first();
console.log('outbound-flight row present:', (await seg.count()) > 0);
if (await seg.count()) {
	await seg.click();
	await page.waitForTimeout(4000);
}
const buttons = await page.evaluate(() =>
	[...document.querySelectorAll('button')]
		.map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '))
		.filter(Boolean)
		.slice(0, 40)
);
console.log('buttons after opening the flight row:');
for (const b of [...new Set(buttons)]) console.log('  ' + b.slice(0, 80));
await browser.close();
