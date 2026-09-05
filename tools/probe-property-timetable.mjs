/**
 * Issue #267, the timetable half: does a swapped bed say its journey is road only, and does
 * asking for the bus actually get one?
 *
 *   node tools/probe-property-timetable.mjs '<results url>' "<property>" ["<property>" ...]
 *
 * Name several properties and it swaps and presses on each in turn, which is how the ration
 * gets checked rather than asserted. The search spends most of the twelve itself, so the
 * third or fourth press should be refused and say so, with nothing sent. If the page ever
 * handed the panel a budget of its own, every press would succeed and this is the run that
 * would show it.
 *
 * `probe-stay-routing.mjs` proves the road route lands. This picks up where that stops: it
 * opens the leg's picker, reads the notice, presses "Check public transport", and counts
 * what the press sends to Transitous. That count is the whole argument. Two requests per
 * press against a volunteer-run service is a number somebody has to be able to check rather
 * than take on trust, and the reason the lookup is behind a press at all.
 *
 * It also reads the cost line before pressing, because a button that spends somebody's
 * allowance without saying so is the defect this feature exists to avoid.
 *
 * Its own Chromium, closed at the end, IndexedDB cleared unless told not to.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(readFileSync(path.join(here, '..', 'tests', 'e2e', 'fixtures', 'markers.json'), 'utf-8'));
const FIXTURE_TOKENS = [markers.textToken, ...markers.flightNumbers];

const url = process.argv[2];
const wantedProperties = process.argv.slice(3).filter((argument) => !argument.startsWith('--'));
if (!url || wantedProperties.length === 0) throw new Error('pass a results URL and at least one property name');
const keepCache = process.argv.includes('--keep-cache');
const appOrigin = new URL(url).origin;

const browser = await chromium.launch();
const context = await browser.newContext({
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
});
const page = await context.newPage();

let osrmRequests = 0;
let transitousRequests = 0;
const transitousUrls = [];
page.on('request', (r) => {
	const host = new URL(r.url()).host;
	if (host === 'routing.openstreetmap.de') osrmRequests += 1;
	if (host.endsWith('transitous.org') || host.endsWith('motis-project.de')) {
		transitousRequests += 1;
		transitousUrls.push(r.url());
	}
});
page.on('pageerror', (e) => console.log('PAGE ERROR', String(e).slice(0, 400)));
page.on('console', (m) => {
	if (m.type() === 'error') console.log('CONSOLE ERROR', m.text().slice(0, 400));
});

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

await page.goto(url);
await page.waitForFunction(() => !document.body.innerText.includes('still searching'), null, { timeout: 180_000 });
await page.getByRole('button', { name: 'Show details' }).first().click();
const detail = page.locator('.result-detail').first();
await detail.waitFor({ timeout: 30_000 });

const pageText = await page.evaluate(() => document.body.innerText);
const leaked = FIXTURE_TOKENS.filter((t) => pageText.includes(t));
if (leaked.length > 0) {
	console.log('MEASUREMENT INVALID: fixture markers on the page:', leaked.join(', '));
	await browser.close();
	process.exit(2);
}

const flat = (s) => s.replace(/\s*\n\s*/g, ' | ').trim();
const rowText = async (segment) => {
	const row = detail.locator(`[data-segment="${segment}"]`);
	return (await row.count()) > 0 ? flat(await row.first().innerText()) : '(row absent)';
};

console.log('\n----- as opened -----');
console.log('TO-BED   :', await rowText('transfer-to-hotel'));
console.log('FROM-BED :', await rowText('transfer-to-connection-airport'));
console.log(`\nsearch cost: ${osrmRequests} OSRM, ${transitousRequests} Transitous`);

async function openStayPicker() {
	if ((await detail.locator('.stay-picker, .stay-notice').count()) === 0) {
		await detail.locator('[data-segment="free-time"]').first().click();
		await page.waitForTimeout(200);
	}
}

for (const wanted of wantedProperties) {
	await openStayPicker();
	const card = detail.locator('.alt-card', { hasText: wanted }).first();
	if ((await card.count()) === 0) {
		const offered = await detail.locator('.alt-card').allInnerTexts();
		throw new Error(`no alternative card named ${wanted}. Offered:\n${offered.map(flat).join('\n')}`);
	}
	const beforeSwap = { osrm: osrmRequests, transitous: transitousRequests };
	await card.click();

	for (let elapsed = 0; elapsed < 40_000; elapsed += 1000) {
		await page.waitForTimeout(1000);
		if (!(await rowText('transfer-to-hotel')).includes('Nothing routed')) break;
	}

	console.log(`\n===== "${wanted}" =====`);
	console.log('TO-BED   :', await rowText('transfer-to-hotel'));
	console.log('FROM-BED :', await rowText('transfer-to-connection-airport'));
	console.log(
		`the swap cost: ${osrmRequests - beforeSwap.osrm} OSRM, ${transitousRequests - beforeSwap.transitous} Transitous`
	);

	// The stopover fold is still open on the free-time row, and only one row's fold shows at
	// a time, so this both closes that one and opens the leg being measured.
	await detail.locator('[data-segment="transfer-to-hotel"]').first().click();
	await page.waitForTimeout(200);

	const picker = detail.locator('[data-segment="transfer-to-hotel"] .tl-expansion').first();
	const notice = picker.locator('[data-testid="transit-notice"]').first();
	console.log('NOTICE   :', (await notice.count()) > 0 ? flat(await notice.innerText()) : '(no notice)');
	const offer = picker.locator('.transit-check').first();
	console.log('OFFER    :', (await offer.count()) > 0 ? flat(await offer.innerText()) : '(no offer)');

	const check = picker.getByRole('button', { name: 'Check public transport' }).first();
	if ((await check.count()) === 0) {
		console.log('no button on this leg, so nothing to press');
		continue;
	}

	const beforePress = { osrm: osrmRequests, transitous: transitousRequests };
	await check.click();
	for (let elapsed = 0; elapsed < 40_000; elapsed += 1000) {
		await page.waitForTimeout(1000);
		if (!flat(await picker.innerText()).includes('Public transport was not looked up')) break;
	}

	console.log('AFTER    :', await rowText('transfer-to-hotel'));
	console.log('NOTICE   :', (await notice.count()) > 0 ? flat(await notice.innerText()) : '(no notice)');
	console.log(
		`the press cost: ${osrmRequests - beforePress.osrm} OSRM, ${transitousRequests - beforePress.transitous} Transitous`
	);
	for (const sent of transitousUrls.slice(beforePress.transitous)) console.log('  sent:', sent);
}

console.log(`\nin total: ${osrmRequests} OSRM, ${transitousRequests} Transitous`);
await browser.close();
