/**
 * Issue #290: does any surface print the landing-to-transport buffer as though it were the
 * ride?
 *
 *   node tools/probe-landing-buffer.mjs '<results url>' [--keep-cache]
 *
 * It loads the same itinerary twice, once per `transport=` rule in the URL it is given and
 * once with the buffer set to zero, and prints every place a ground duration appears: the
 * timeline row, the stopover block's own sentence, the segment stub, the trip strip's
 * spoken label, and each row of the transport picker. Two readings of one journey where
 * only a traveller setting changed, so any number that moves with the setting is a number
 * that has the setting folded into it.
 *
 * Zero is the control on purpose. Every duration in the two readings that differs is
 * buffered; every duration that matches is the ride the router measured.
 *
 * Its own Chromium, closed at the end, IndexedDB cleared unless told not to.
 */
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const url = process.argv[2];
if (!url) throw new Error('pass a results URL');
const keepCache = process.argv.includes('--keep-cache');
const appOrigin = new URL(url).origin;

const withRule = (rule) => {
	const next = new URL(url);
	next.searchParams.set('transport', rule);
	return next.toString();
};

const flat = (s) => s.replace(/\s*\n\s*/g, ' | ').trim();

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', String(e).slice(0, 400)));

async function reading(label, target) {
	await page.goto(appOrigin);
	if (!keepCache) {
		await page.evaluate(
			() =>
				new Promise((r) => {
					const req = indexedDB.deleteDatabase('flights-cache');
					req.onsuccess = req.onerror = req.onblocked = () => r();
				})
		);
	}
	await page.goto(target);
	await page.waitForFunction(() => !document.body.innerText.includes('still searching'), null, {
		timeout: 180_000
	});

	console.log(`\n================ ${label} ================`);

	const stripLabels = await page.evaluate(() =>
		[...document.querySelectorAll('.trip-strip button[aria-label]')]
			.map((el) => el.getAttribute('aria-label') ?? '')
			.filter((text) => text.startsWith('Transport'))
	);
	for (const text of stripLabels) console.log('STRIP LABEL    :', text);

	const stripButtons = page.locator('.trip-strip button[aria-label^="Transport"]');
	for (let i = 0; i < (await stripButtons.count()); i += 1) {
		await stripButtons.nth(i).click();
		await page.waitForTimeout(250);
		const stub = page.locator('.stub-transport:visible').first();
		if ((await stub.count()) > 0) console.log(`STUB ${i}         :`, flat(await stub.innerText()));
		await page.keyboard.press('Escape');
		await page.waitForTimeout(150);
	}

	await page.getByRole('button', { name: 'Show details' }).first().click();
	const detail = page.locator('.result-detail').first();
	await detail.waitFor({ timeout: 30_000 });

	const stopover = detail.locator('.stopover').first();
	if ((await stopover.count()) > 0) console.log('STOPOVER BLOCK :', flat(await stopover.innerText()));

	for (const segment of ['transfer-to-hotel', 'transfer-to-connection-airport', 'transfer-to-destination-location']) {
		const row = detail.locator(`[data-segment="${segment}"]`).first();
		if ((await row.count()) === 0) continue;
		console.log(`ROW ${segment.padEnd(34)}:`, flat(await row.innerText()));
	}

	const bed = detail.locator('[data-segment="transfer-to-hotel"]').first();
	if ((await bed.count()) > 0) {
		await bed.click();
		await page.waitForTimeout(300);
		const rows = bed.locator('.picker-row');
		for (let i = 0; i < (await rows.count()); i += 1) {
			console.log(`PICKER ROW ${i}   :`, flat(await rows.nth(i).innerText()));
		}
	}
}

await reading('as the URL asks (the shipped default)', withRule('*:15,large:30'));
await reading('CONTROL: the same journey with the buffer at zero', withRule('*:0'));

await browser.close();
