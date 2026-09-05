import { chromium } from '@playwright/test';
const url = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' })).newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
console.log(await page.evaluate(() => {
	const out = [];
	for (const el of document.querySelectorAll('*')) {
		if (el.children.length) continue;
		const t = (el.innerText || '').trim();
		if (!/\(\d+\)$/.test(t)) continue;
		let node = el, path = [];
		for (let i = 0; i < 4 && node; i++, node = node.parentElement) path.push(node.tagName.toLowerCase() + (node.getAttribute('role') ? `[role=${node.getAttribute('role')}]` : ''));
		const ctrl = el.closest('label')?.querySelector('input,select,button') || el.closest('button,[role=checkbox],[role=button]');
		out.push(`${t}  ::  ${path.join(' < ')}  ::  control=${ctrl ? ctrl.tagName.toLowerCase() + (ctrl.type ? '/' + ctrl.type : '') : 'NONE'}`);
	}
	return out.slice(0, 10).join('\n') || '(no "(n)" labels in DOM)';
}));
await browser.close();
