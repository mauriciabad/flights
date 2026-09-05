import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 45000 }).catch(() => {});
for (let i = 0; i < 50; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
const t = await page.evaluate(() => document.body.innerText);
console.log('nights mentioned across all cards:', JSON.stringify([...new Set(t.match(/\d+ nights? in [A-Za-z ]+/g) || [])]));
console.log('night filter options:', await page.evaluate(() => {
  const s = [...document.querySelectorAll('select')].find(x => /night/i.test(x.getAttribute('aria-label') || x.id || ''));
  return s ? [...s.options].map(o => o.text) : 'no nights select found';
}));
await browser.close();
