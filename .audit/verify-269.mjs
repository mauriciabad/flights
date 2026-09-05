// UNFINISHED, and kept on purpose. This probe cannot reach a flight swap on
// production: `swapped a flight` logs false, because the selector for the picker's
// alternatives is wrong. Its value is the shape, not the result. It logs whether the
// swap happened alongside the two window readings, which is the only reason its
// identical before/after was not mistaken for a pass.
//
// Whoever finishes it: .audit/dump-picker.mjs prints what the picker actually renders
// after clicking [data-segment="outbound-flight"]. On 2026-09-05 that showed the strip's
// segment buttons and no flight alternatives, so either the row click does not open the
// picker from a script or the alternatives are not <button> elements.
//
// Assert that you reached the state, not only what you saw once there.
import { chromium } from '@playwright/test';
import { newProbeContext } from '../tools/probe-browser.mjs';

const TARGET =
	'https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO';

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();
await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(60000);

const opener = page.getByRole('button', { name: /show details/i }).first();
if (await opener.count()) {
	await opener.click();
	await page.waitForTimeout(5000);
}

const readWindow = () =>
	page.evaluate(() => {
		const t = document.body.innerText;
		const edges = t.match(/\w{3} \d{1,2} (from|until) \d{1,2}(:\d\d)?(am|pm)/g) || [];
		const days = t.match(/(No full days|\d+ full days?:[^\n]*)/g) || [];
		return { edges: edges.slice(0, 2), days: days.slice(0, 1) };
	});

const before = await readWindow();
console.log('free-time window before the swap:', JSON.stringify(before));

// Open the outbound flight row, then pick an alternative, then read the window again.
const flightRow = page.locator('[data-segment="outbound-flight"]').first();
let swapped = false;
if (await flightRow.count()) {
	await flightRow.click();
	await page.waitForTimeout(3000);
	const alt = page.getByRole('button', { name: /choose|select|pick/i }).nth(1);
	if (await alt.count()) {
		await alt.click().catch(() => {});
		await page.waitForTimeout(4000);
		swapped = true;
	}
}
console.log('swapped a flight:', swapped);
const after = await readWindow();
console.log('free-time window after the swap: ', JSON.stringify(after));

await browser.close();
