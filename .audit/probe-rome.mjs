import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 45000 }).catch(() => {});
for (let i = 0; i < 50; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
// find the Rome card and expand it
const cards = await page.$$('article');
for (const c of cards) {
	const t = await c.innerText();
	if (!/Rome|FCO/.test(t)) continue;
	const btn = await c.$('button:has-text("Show details")');
	if (btn) { await btn.click(); await page.waitForTimeout(1500); }
	const full = await c.innerText();
	console.log(full.replace(/\n{2,}/g, '\n').slice(0, 1600));
	break;
}
await browser.close();
