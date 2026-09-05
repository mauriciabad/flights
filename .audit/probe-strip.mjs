import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 375, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
const m = await page.evaluate(() => {
	const card = document.querySelector('article, .result-card, [class*="card"]');
	const strip = document.querySelector('[class*="trip-strip"], [class*="strip"]');
	return {
		cardHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
		stripHeight: strip ? Math.round(strip.getBoundingClientRect().height) : null,
		stripText: strip ? strip.innerText.replace(/\s+/g, ' ').slice(0, 220) : null
	};
});
console.log(JSON.stringify(m, null, 1));
await page.screenshot({ path: '/tmp/shots/strip-375.png', clip: { x: 0, y: 40, width: 375, height: 460 } });
await browser.close();
