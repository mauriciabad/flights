import { chromium } from '@playwright/test';
import { newProbeContext } from '../tools/probe-browser.mjs';

const URL =
	'https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const browser = await chromium.launch();
const context = await newProbeContext(browser);
await context.route('**://api.m.hostelworld.com/**', (route) =>
	route.fulfill({
		status: 503,
		contentType: 'text/html',
		body: '<html><head><title>503 Service Unavailable</title></head><body><h1>503 Service Unavailable</h1></body></html>',
	})
);
const page = await context.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(55000);

const opener = page.getByRole('button', { name: /show details|details|expand/i }).first();
if (await opener.count()) {
	await opener.click();
	await page.waitForTimeout(4000);
}

const buttons = await page.evaluate(() =>
	[...document.querySelectorAll('button,summary,[role=button]')]
		.map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60))
		.filter(Boolean)
);
console.log('--- clickable things on the page ---');
console.log([...new Set(buttons)].join('\n'));

console.log('\n--- does the page mention the failure at all? ---');
const body = await page.evaluate(() => document.body.innerText);
for (const needle of ['503', 'Hostelworld', 'nothing is known', 'could not answer', 'Service Unavailable']) {
	console.log(`${body.toLowerCase().includes(needle.toLowerCase()) ? 'present' : 'absent '}  ${needle}`);
}

console.log('\n--- text around any Hostelworld mention ---');
const i = body.toLowerCase().indexOf('hostelworld');
console.log(i >= 0 ? body.slice(Math.max(0, i - 400), i + 600) : '(no mention)');

await browser.close();
