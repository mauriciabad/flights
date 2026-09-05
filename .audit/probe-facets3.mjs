/**
 * One fresh page load per facet. The previous version toggled a facet off before testing
 * the next one, but the facet list re-renders after a filter is applied, so an index-based
 * locator can land on a different button and carry state into the next reading.
 */
import { chromium } from '@playwright/test';
const url = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
const settle = async () => {
	await page.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
	for (let i = 0; i < 45; i++) { if (!/still searching/.test(await page.evaluate(() => document.body.innerText))) break; await page.waitForTimeout(2000); }
};
const shown = async () => Number(((await page.evaluate(() => document.body.innerText)).match(/(\d+) of (\d+) itiner/) || [])[1]);

await page.goto(url, { waitUntil: 'domcontentloaded' });
await settle();
const names = await page.evaluate(() => [...document.querySelectorAll('button')]
	.map((b) => (b.innerText || '').trim().replace(/\s+/g, ' ')).filter((t) => /\(\d+\)$/.test(t)));
console.log('baseline', await shown(), '| facets:', names.join(' , '));

for (const name of names) {
	await page.goto(url, { waitUntil: 'domcontentloaded' });
	await settle();
	const before = await shown();
	const want = Number(name.match(/\((\d+)\)$/)[1]);
	await page.getByRole('button', { name, exact: true }).first().click().catch(async () => {
		await page.locator('button', { hasText: name }).first().click().catch(() => {});
	});
	await page.waitForTimeout(1200);
	const got = await shown();
	console.log(`  ${got === want ? 'OK    ' : 'BROKEN'} "${name}"  before=${before} expected=${want} got=${got}`);
}
await browser.close();
