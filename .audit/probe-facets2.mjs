import { chromium } from '@playwright/test';
const url = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
const shown = async () => ((await page.evaluate(() => document.body.innerText)).match(/(\d+) of (\d+) itiner/) || [])[1];
console.log('baseline showing:', await shown());

const targets = await page.evaluate(() => [...document.querySelectorAll('button')]
	.map((b, i) => ({ i, t: (b.innerText || '').trim().replace(/\s+/g, ' '), pressed: b.getAttribute('aria-pressed') }))
	.filter((x) => /\(\d+\)/.test(x.t)));
for (const t of targets) {
	const btn = page.locator('button').nth(t.i);
	const want = Number(t.t.match(/\((\d+)\)/)[1]);
	await btn.click().catch(() => {});
	await page.waitForTimeout(800);
	const got = Number(await shown());
	console.log(`  ${got === want ? 'OK    ' : 'BROKEN'} "${t.t}" expected ${want}, list shows ${got}, aria-pressed=${t.pressed ?? 'absent'}`);
	await btn.click().catch(() => {});
	await page.waitForTimeout(500);
}
console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
