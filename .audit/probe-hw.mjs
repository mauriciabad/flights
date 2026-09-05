import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
const hw = [];
const reads = [];
page.on('response', (r) => {
	if (!r.url().includes('hostelworld')) return;
	reads.push(r.text().then((b) => hw.push({ u: r.url(), status: r.status(), b })).catch(() => {}));
});
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 180)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 180)));
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
await Promise.race([Promise.allSettled(reads), new Promise((r) => setTimeout(r, 6000).unref())]);
for (const { u, status, b } of hw) {
	const short = u.replace('https://api.m.hostelworld.com/2.2/', '').slice(0, 95);
	let props = null;
	try { const j = JSON.parse(b); props = Array.isArray(j.properties) ? j.properties.length : (j.properties ? 'obj' : null); } catch { /* not json */ }
	console.log(`${status}  props=${props}  bytes=${b.length}  ${short}`);
	if (props && props > 0) {
		const j = JSON.parse(b);
		console.log('   first:', j.properties[0]?.name, '| lowestAvgDorm:', j.properties[0]?.lowestAverageDormPricePerNight, '| coords:', j.properties[0]?.latitude, j.properties[0]?.longitude);
	}
}
console.log('console errors:', errs.slice(0, 4));
await browser.close();
