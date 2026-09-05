import { chromium } from '@playwright/test';
const url = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({
	viewport: { width: 375, height: 720 },
	userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
})).newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
const box = async (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) }; }, sel);
console.log('viewport 375x720');
for (const s of ['.app-shell', '.app-header', '.app-nav', '.app-content']) console.log(' ', s, JSON.stringify(await box(s)));
console.log('  documentScrollHeight', await page.evaluate(() => document.documentElement.scrollHeight));
await page.screenshot({ path: '/tmp/shots/header-top.png' });
await page.evaluate(() => document.querySelector('.app-content')?.scrollBy(0, 900));
await page.waitForTimeout(400);
console.log('after scrolling .app-content by 900:');
for (const s of ['.app-header', '.app-nav']) console.log(' ', s, JSON.stringify(await box(s)));
await page.screenshot({ path: '/tmp/shots/header-scrolled.png' });
await browser.close();
