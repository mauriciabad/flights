/**
 * Acceptance condition 4, and a class of bug this repo has shipped before: a control that
 * looks functional and is wired to nothing. Each facet label carries its own count, e.g.
 * "London LGW (1)", so selecting it is a checkable assertion rather than a judgement.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({
	userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
})).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
for (let i = 0; i < 45; i++) {
	if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break;
	await page.waitForTimeout(2000);
}
const shown = async () => {
	const t = await page.evaluate(() => document.body.innerText);
	const m = t.match(/(\d+) of (\d+) itiner/);
	return m ? `${m[1]}/${m[2]}` : '(none)';
};
console.log('baseline:', await shown());

// Facet checkboxes/radios whose label carries "(n)". Selecting one must leave n showing.
const facets = await page.evaluate(() => {
	const out = [];
	for (const el of document.querySelectorAll('label')) {
		const m = el.innerText.match(/^(.*?)\s*\((\d+)\)\s*$/);
		if (m && el.querySelector('input')) out.push({ label: m[1].trim(), expected: Number(m[2]) });
	}
	return out;
});
console.log('facets found:', facets.length, facets.map((f) => `${f.label}=${f.expected}`).join(', ') || '(none)');

for (const f of facets.slice(0, 6)) {
	const box = page.locator('label', { hasText: new RegExp(`^${f.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`) }).first();
	await box.locator('input').check({ force: true }).catch(() => {});
	await page.waitForTimeout(700);
	const after = await shown();
	const got = Number(String(after).split('/')[0]);
	console.log(`  ${got === f.expected ? 'OK  ' : 'WIRED?'} ${f.label}: label says ${f.expected}, list shows ${after}`);
	await box.locator('input').uncheck({ force: true }).catch(() => {});
	await page.waitForTimeout(500);
}

// The nights control, which is what acceptance condition 4 is really about.
const nights = page.getByLabel(/minimum nights/i).first();
if (await nights.count()) {
	const before = await shown();
	await nights.selectOption({ index: 2 }).catch(async () => { await nights.fill('4').catch(() => {}); });
	await page.waitForTimeout(800);
	console.log(`nights control: ${before} -> ${await shown()} (must move or honestly empty)`);
} else console.log('nights control: NOT FOUND');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
