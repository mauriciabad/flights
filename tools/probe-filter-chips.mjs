/**
 * Issue #189. Each facet chip in the results rail carries its own count, so one click is a
 * checkable promise: "London LGW (1)" must leave exactly 1 itinerary on screen, and the chip
 * must say out loud that it is now the one doing the filtering.
 *
 *   node tools/probe-filter-chips.mjs 'http://127.0.0.1:41890/results/?...'
 *
 * One fresh page load per facet. The earlier .audit/probe-facets.mjs toggled a facet off
 * before testing the next, and the rail re-renders after a filter applies, so an index-based
 * locator landed on a different button and carried state into the next reading. It reported
 * inverted logic that was not there.
 *
 * The pointer is parked at 0,0 before every style read. The first report of this bug measured
 * a chip's background with the mouse still resting on it and read the hover colour as the
 * selected colour.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2];
if (!url) {
	console.error('usage: node tools/probe-filter-chips.mjs <results url>');
	process.exit(2);
}

const browser = await chromium.launch();
const page = await (
	await browser.newContext({
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
	})
).newPage();

const settle = async () => {
	await page
		.waitForFunction(() => /\d+ of \d+ itiner/.test(document.body.innerText), null, { timeout: 90_000 })
		.catch(() => {});
	for (let i = 0; i < 60; i++) {
		if (!/still searching/i.test(await page.evaluate(() => document.body.innerText))) break;
		await page.waitForTimeout(2000);
	}
	await page.mouse.move(0, 0);
};

const shown = async () =>
	Number(((await page.evaluate(() => document.body.innerText)).match(/(\d+) of (\d+) itiner/) ?? [])[1]);

const readChips = () =>
	page.evaluate(() =>
		[...document.querySelectorAll('.chip-toggle')].map((button, index) => {
			const chip = button.closest('.chip');
			const style = getComputedStyle(chip);
			return {
				index,
				text: (button.textContent ?? '').trim().replace(/\s+/g, ' '),
				group:
					chip.closest('.filter-control')?.querySelector('.filter-control-head span')?.textContent?.trim() ??
					'?',
				pressed: button.getAttribute('aria-pressed'),
				isSelected: chip.classList.contains('is-selected'),
				background: style.backgroundColor,
				border: style.borderColor
			};
		})
	);

const paint = (c) => `pressed=${c.pressed} is-selected=${c.isSelected} bg=${c.background} border=${c.border}`;

await page.goto(url, { waitUntil: 'domcontentloaded' });
await settle();
const baseline = await shown();
const facets = (await readChips()).filter((c) => /\((\d+)\)/.test(c.text));
console.log(`baseline: ${baseline} itineraries, ${facets.length} facet chips`);
console.log(`default chip state: ${facets.map((c) => `${c.text}[${paint(c)}]`).join(' ')}\n`);

console.log('| clicked | group | label promises | list shows | verdict | chip before | chip after |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');

let failures = 0;
for (const facet of facets) {
	await page.goto(url, { waitUntil: 'domcontentloaded' });
	await settle();

	const fresh = (await readChips())[facet.index];
	if (!fresh || fresh.text !== facet.text) {
		console.log(`| ${facet.text} | ${facet.group} | - | - | SKIPPED, rail reordered between loads | - | - |`);
		failures += 1;
		continue;
	}

	const promised = Number(facet.text.match(/\((\d+)\)/)[1]);
	const before = fresh;
	await page.locator('.chip-toggle').nth(facet.index).click();
	await page.waitForTimeout(900);
	await page.mouse.move(0, 0);
	await page.waitForTimeout(150);

	const got = await shown();
	const after = (await readChips())[facet.index];
	const listOk = got === promised;
	const chipOk = after.pressed !== before.pressed || after.isSelected !== before.isSelected;
	if (!listOk || !chipOk) failures += 1;

	const verdict = listOk ? (chipOk ? 'OK' : 'LIST OK, CHIP MUTE') : chipOk ? 'LIST WRONG' : 'BOTH WRONG';
	console.log(
		`| ${facet.text} | ${facet.group} | ${promised} | ${got} | ${verdict} | ${paint(before)} | ${paint(after)} |`
	);
}

console.log(`\n${failures === 0 ? 'ALL FACETS HONEST' : `${failures} of ${facets.length} facets broken`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
