import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 375, height: 720 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
await page.evaluate(() => document.querySelector('.app-content')?.scrollBy(0, 900));
await page.waitForTimeout(400);
console.log(await page.evaluate(() => {
	const out = [];
	const sum = document.querySelector('.summary');
	if (sum) { const r = sum.getBoundingClientRect(); out.push(`.summary box top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} z=${getComputedStyle(sum).zIndex} pos=${getComputedStyle(sum).position} bg=${getComputedStyle(sum).backgroundColor}`); }
	for (const y of [52, 58, 64, 70, 76, 82]) {
		const el = document.elementFromPoint(180, y);
		if (!el) { out.push(`y=${y} -> null`); continue; }
		const cs = getComputedStyle(el);
		out.push(`y=${y} -> ${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 34)} z=${cs.zIndex} pos=${cs.position} text="${(el.innerText || '').trim().slice(0, 20)}"`);
	}
	return out.join('\n');
}));
await browser.close();
