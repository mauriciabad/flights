import { chromium } from '@playwright/test';
const browser = await chromium.launch();
for (const pass of [1, 2]) {
	const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
	const errs = [];
	page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
	await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
	for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
	const t = await page.evaluate(() => document.body.innerText);
	const count = (t.match(/(\d+) of (\d+) itiner/) || [])[0];
	const cities = [...new Set((t.match(/(Birmingham|London|Manchester|Rome|Milan)/g) || []))];
	console.log(`pass ${pass}: ${count} | cities: ${cities.join(',')} | failedToFetch: ${/failed to fetch/i.test(t)} | bedPriced: ${!/not priced|no bed priced/i.test(t)} | consoleErrs: ${errs.length}`);
	await page.close();
}
await browser.close();
