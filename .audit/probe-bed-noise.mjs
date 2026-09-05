import { chromium } from '@playwright/test';
const url = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
const count = (t) => (t.match(/no bed priced|bed not priced|unpriced stay|nowhere to travel|nothing routed/gi) || []);
let t = await page.evaluate(() => document.body.innerText);
console.log('collapsed list, bed mentions:', count(t).length, JSON.stringify([...new Set(count(t))]));
const btn = page.getByRole('button', { name: /show details/i }).first();
if (await btn.count()) { await btn.click(); await page.waitForTimeout(1500); }
t = await page.evaluate(() => document.body.innerText);
const hits = count(t);
console.log('one card expanded, bed mentions:', hits.length);
for (const [k, v] of Object.entries(hits.reduce((a, h) => ((a[h.toLowerCase()] = (a[h.toLowerCase()] || 0) + 1), a), {}))) console.log(`   ${v}x  ${k}`);
await browser.close();
