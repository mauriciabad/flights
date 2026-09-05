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

// stayIsRelevant is `nightsInConnection > 0 || stay !== undefined`, so a zero-night
// flight change correctly shows no missing-bed notice. Expanding the first card on the
// page therefore proves nothing. Pick a card that actually has a night in it.
const cards = await page.evaluate(() =>
	[...document.querySelectorAll('article, li, section')]
		.map((el, i) => ({ i, t: (el.innerText || '').slice(0, 400) }))
		.filter((c) => /\bnight\b/i.test(c.t) && /show details/i.test(c.t))
		.map((c) => c.t.split('\n').slice(0, 3).join(' | '))
);
console.log('cards with a night and a details button:', JSON.stringify(cards.slice(0, 4), null, 1));

const withNight = page
	.locator('article, li, section')
	.filter({ hasText: /\bnight\b/i })
	.filter({ has: page.getByRole('button', { name: /show details/i }) })
	.last();
const opener = withNight.getByRole('button', { name: /show details/i }).first();
console.log('opener on a card with a night:', (await opener.count()) > 0);
if (await opener.count()) {
	await opener.click();
	await page.waitForTimeout(5000);
}

// The notice lives in `stepOptions`, a snippet rendered only for the timeline row the
// reader has opened. "Show details" is one click; opening the free-time row is a second.
// Stopping at the first click is what made the earlier probe report two false failures.
const row = page.getByRole('button', { name: /stopover in|free time|nights? in/i }).first();
console.log('free-time row found:', (await row.count()) > 0);
if (await row.count()) {
	await row.click();
	await page.waitForTimeout(4000);
}

const notice = await page.evaluate(() => {
	const box = document.querySelector('[data-testid="stay-notice"]');
	const failures = [...document.querySelectorAll('[data-testid="stay-provider-failure"]')].map(
		(n) => n.innerText.trim()
	);
	return { present: Boolean(box), text: box?.innerText.trim() ?? null, failures };
});

console.log('stay-notice present:', notice.present);
console.log('notice text:', notice.text);
console.log('provider failure lines:', JSON.stringify(notice.failures, null, 1));

const strip = await page.evaluate(() => {
	const t = document.body.innerText;
	const i = t.indexOf('PROVIDERS ASKED');
	return i >= 0 ? t.slice(i, i + 260) : '(strip not found)';
});
console.log('--- provider strip ---\n' + strip);

await browser.close();
