import { chromium } from '@playwright/test';
const browser = await chromium.launch();
for (const w of [375, 1280]) {
	const page = await (await browser.newContext({ viewport: { width: w, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
	await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
	for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
	const r = await page.evaluate(() => {
		const route = document.querySelector('.route');
		if (!route) return null;
		const rect = route.getBoundingClientRect();
		return { text: route.innerText.replace(/\s+/g, ' ').trim().slice(0, 90), height: Math.round(rect.height), width: Math.round(rect.width) };
	});
	console.log(`${w}px:`, JSON.stringify(r));
	await page.screenshot({ path: `/tmp/shots/route-${w}.png`, clip: { x: 0, y: 0, width: w, height: 420 } });
	await page.close();
}
await browser.close();
