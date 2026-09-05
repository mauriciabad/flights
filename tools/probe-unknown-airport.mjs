/**
 * Issue #327: a results URL can carry an airport code, a date or a pair of dates that no
 * search could ever answer. This drives each of those URLs in its own Chromium and reports
 * the two things that matter together: what the traveller reads where the results would
 * have been, and whether an uncaught `pageerror` reached the console.
 *
 *   node tools/probe-unknown-airport.mjs https://flights.mauri.app
 *   node tools/probe-unknown-airport.mjs http://localhost:4327
 *
 * Both halves are the fix. Before #327 the destination case printed "0 of 0 itineraries
 * shown", which claims a search ran, while `runSearch` threw "require both airports to
 * resolve" into the console where nobody would read it.
 *
 * Its own browser, never the shared Playwright MCP one: other agents drive that and change
 * its URL between two tool calls (AGENTS.md, "Testing the live app without lying to
 * yourself"). Zero provider requests in every case here, since a query this page refuses
 * is a query it never asks anyone about.
 */
import { chromium } from '@playwright/test';

const origin = (process.argv[2] ?? 'http://localhost:4327').replace(/\/$/, '');
const DEPARTURE = '2026-10-06';
const ARRIVAL = '2026-10-12';

const cases = [
	{
		name: 'unknown destination',
		params: `arr=${ARRIVAL}&dep=${DEPARTURE}&from=BCN&to=ZZZ`,
		expect: /ZZZ/
	},
	{
		name: 'unknown origin',
		params: `arr=${ARRIVAL}&dep=${DEPARTURE}&from=ZZZ&to=BCN`,
		expect: /ZZZ/
	},
	{
		name: 'both unknown',
		params: `arr=${ARRIVAL}&dep=${DEPARTURE}&from=ZZZ&to=QQQ`,
		expect: /ZZZ[\s\S]*QQQ/
	},
	{
		name: 'missing destination',
		params: `arr=${ARRIVAL}&dep=${DEPARTURE}&from=BCN`,
		expect: /flying to/i
	},
	{
		name: 'impossible date',
		params: `arr=${ARRIVAL}&dep=2026-02-31&from=BCN&to=OTP`,
		expect: /YYYY-MM-DD/
	},
	{
		name: 'arrival before departure',
		params: `arr=2026-10-01&dep=${DEPARTURE}&from=BCN&to=OTP`,
		expect: /cannot arrive before you leave/i
	}
];

/** The wording that says a search ran and answered nothing. On every URL here no search
 * ran, so reading this line anywhere on the page is the #327 defect itself. */
const CLAIMS_A_SEARCH_RAN = /\d+ of \d+ itiner/;

const browser = await chromium.launch();
const failures = [];

for (const testCase of cases) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const pageErrors = [];
	const providerRequests = [];
	page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)));
	page.on('request', (request) => {
		const url = request.url();
		if (!url.startsWith(origin) && /^https?:/.test(url)) providerRequests.push(url.slice(0, 90));
	});

	const url = `${origin}/results/?${testCase.params}`;
	await page.goto(url, { waitUntil: 'domcontentloaded' });
	// No search runs on any of these, so there is no "still searching" to wait out. Give
	// the airport dataset time to load and the page time to settle on its verdict.
	await page.waitForTimeout(6000);
	const text = await page.evaluate(() => document.body.innerText);

	const problems = [];
	if (!testCase.expect.test(text)) problems.push(`no match for ${testCase.expect}`);
	if (CLAIMS_A_SEARCH_RAN.test(text)) {
		problems.push(`claims a search ran: "${text.match(CLAIMS_A_SEARCH_RAN)[0]}"`);
	}
	if (pageErrors.length > 0) problems.push(`uncaught pageerror: ${pageErrors[0]}`);
	if (providerRequests.length > 0) problems.push(`asked a provider: ${providerRequests[0]}`);

	console.log(`\n${problems.length === 0 ? 'PASS' : 'FAIL'}  ${testCase.name}`);
	console.log(`  ${url}`);
	for (const problem of problems) console.log(`  ! ${problem}`);
	const shown = text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 14);
	for (const line of shown) console.log(`  | ${line}`);
	if (problems.length > 0) failures.push(testCase.name);

	await context.close();
}

await browser.close();
console.log(`\n${cases.length - failures.length}/${cases.length} passed`);
if (failures.length > 0) {
	console.log(`failed: ${failures.join(', ')}`);
	process.exit(1);
}
