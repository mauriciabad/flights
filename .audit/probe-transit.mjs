import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
const calls = [];
page.on('request', (r) => { if (r.url().includes('transitous')) calls.push(r.url()); });
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 45000 }).catch(() => {});
for (let i = 0; i < 50; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
console.log('transitous requests:', calls.length);
for (const u of calls.slice(0, 8)) {
	const q = new URL(u).searchParams;
	console.log(`  from=${q.get('fromPlace')}  to=${q.get('toPlace')}  time=${q.get('time')}`);
}
await browser.close();
