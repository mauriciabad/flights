/**
 * Re-reads every British figure in `providers/transfers/transit-fare-table.ts` on the page
 * it was cited from, and says whether the page still carries it. Issue #415. The Gatwick
 * rows check the module header rather than a card: Gatwick's two bounds are cited there as
 * the reason it is now kept out for a distance argument instead of an unreadable fare, and
 * a reason resting on numbers wants the numbers checked too.
 *
 *   node tools/probe-uk-transit-fares.mjs [--only BHX] [--dump]
 *
 * This exists because issue #407 concluded, from real measurement, that no British airport
 * could be priced: six rail operator sites answered 403, tfgm.com answered 202, and
 * gatwickexpress.com's only fare was a £2 child ticket. Two of those readings were sound
 * and the conclusion drawn from them was not. tfgm.com's 202 is a bot challenge that
 * renders the page anyway, so it fails only if you judge it by its status code, and a train
 * operating company is not the only publisher of a rail fare: National Rail Enquiries
 * renders the whole walk-up ticket list for a named journey as server-side HTML.
 *
 * So a checking instrument, not a research script. Every row below names the page, the
 * words that must still be on it, and the figure the table claims. A row goes:
 *
 *   FOUND     the page rendered and every expected string is on it
 *   CHANGED   the page rendered and something the table cites is gone, so read it yourself
 *   BLOCKED   nothing rendered, which is a bot block and not a missing fare (AGENTS.md)
 *
 * CHANGED and BLOCKED both exit non-zero, and they are different work: the first means a
 * citation is stale, the second means this probe needs a better disguise.
 *
 * Its own Chromium, closed at the end, with `tools/probe-browser.mjs`'s User-Agent and a
 * London locale. Never the shared MCP browser: AGENTS.md, "Testing the live app without
 * lying to yourself".
 */
import { chromium } from '@playwright/test';
import { newProbeContext } from './probe-browser.mjs';

const dump = process.argv.includes('--dump');
/** `--only BHX` narrows the run to one airport's citations, which is what you want when a
 * single row went CHANGED and you are reading the page to find out why. */
const only = (() => {
	const at = process.argv.indexOf('--only');
	return at === -1 ? null : (process.argv[at + 1] ?? '').toUpperCase();
})();

/** A weekday three weeks out, `DDMMYY`, for the National Rail journey planner. Far enough
 * ahead that Advance fares exist beside the walk-up ones (which is what makes the Anytime
 * single identifiable as the dear end) and near enough to be inside the fares horizon. */
function nationalRailDate() {
	const day = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
	while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
	const pad = (n) => String(n).padStart(2, '0');
	return `${pad(day.getUTCDate())}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCFullYear() % 100)}`;
}

const railDate = nationalRailDate();
const rail = (from, to) =>
	`https://ojp.nationalrail.co.uk/service/timesandfares/${from}/${to}/${railDate}/1200/dep`;

/**
 * What the table says, and where it says it came from.
 *
 * `expect` holds strings, not numbers, and each one carries its own context: "£5.00" alone
 * would match any price anywhere on a fares page, which is the trap AGENTS.md's "A string
 * in the markup is not a thing on the page" section is about. On the National Rail pages
 * the ticket name sits beside the price in the expanded panel, so the pair is what gets
 * matched.
 */
const CHECKS = [
	{
		airport: 'BHX',
		claim: 'nBus adult single trip £3.00, the cheap end at Birmingham',
		url: 'https://nxbus.co.uk/west-midlands/tickets-prices/single-trips-day-tickets',
		expect: ['nBus Adult', 'Single trip', '£3']
	},
	{
		airport: 'BHX',
		claim: 'the X1 and X12 call at the terminal, so the £3.00 bus is an airport service',
		url: 'https://www.birminghamairport.co.uk/transport-links/by-bus-or-coach/',
		expect: ['X1 (connecting Birmingham City Centre', 'X12 (connecting Birmingham City Centre']
	},
	{
		airport: 'BHX',
		claim: 'the Air-Rail Link is free, so the rail bound is the train fare alone',
		url: 'https://www.birminghamairport.co.uk/transport-links/by-train/',
		expect: ['Air-Rail Link', 'complimentary service']
	},
	{
		airport: 'BHX',
		claim: 'Anytime Day Single Birmingham International to Birmingham New Street £5.00',
		url: rail('BHI', 'BHM'),
		expandFares: true,
		expect: ['£5.00', 'Anytime']
	},
	{
		airport: 'LGW',
		claim: 'National Express 025 from £6.00, the cheap end the header says Gatwick has',
		url: 'https://www.nationalexpress.com/en/airports/gatwick/london-to-gatwick',
		expect: ['From £6 one-way', 'Limited Availability']
	},
	{
		airport: 'LGW',
		claim: 'Gatwick Express Anytime single £24.10, the dear end, and the £21.30 excluding it',
		url: rail('GTW', 'VIC'),
		expandFares: true,
		expect: ['£24.10', '£21.30', 'Not valid for travel on Gatwick Express services']
	},
	{
		airport: 'LGW',
		claim: 'a London bus or tram is £1.75, the local fare a Gatwick card would have to reach',
		url: 'https://tfl.gov.uk/fares/find-fares/bus-and-tram-fares',
		expect: ['Hopper fare', '£1.75']
	},
	{
		airport: 'MAN',
		claim: "Bee Bus single 'hopper' £2.00, the cheap end at Manchester",
		url: 'https://tfgm.com/tickets-and-passes/bus-tickets',
		expect: ['hopper', '£2 for adults']
	},
	{
		airport: 'MAN',
		claim: 'Metrolink all-zones adult single £4.60',
		url: 'https://tfgm.com/tickets-and-passes/tram-peak-single-ticket-adult',
		expect: ['All zones (1+2+3+4)', '£4.60']
	},
	{
		airport: 'MAN',
		claim: 'the airport is Metrolink zone 4 and the city centre zone 1',
		url: 'https://tfgm.com/tickets-and-passes/fare-zones/tram',
		expect: ['Manchester Airport in zone 4', 'city centre in zone 1']
	},
	{
		airport: 'MAN',
		claim: 'Bee Network buses link the airport to the city centre',
		url: 'https://www.manchesterairport.co.uk/getting-to-and-from/by-bus/',
		expect: ['linked to the city centre by the 24-hour Bee Network bus service', '43, 103, 130']
	},
	{
		airport: 'MAN',
		claim: 'Anytime Day Single Manchester Airport to Manchester Piccadilly £6.20',
		url: rail('MIA', 'MAN'),
		expandFares: true,
		expect: ['£6.20', 'Anytime']
	}
];

const browser = await chromium.launch({
	// Without this, every site behind a bot filter answers a challenge instead of a page,
	// and a challenge reads exactly like a missing fare. Issue #407 lost Britain to that.
	args: ['--disable-blink-features=AutomationControlled']
});

/**
 * One reading of one page, in a context of its own.
 *
 * A context each rather than a tab each, because two checks in a row hit
 * birminghamairport.co.uk and back to back the second answered 403 while the first was a
 * 200. Cookies from the first visit are what the filter recognises, and a fresh context
 * carries none.
 */
async function read(check) {
	const context = await newProbeContext(browser, {
		locale: 'en-GB',
		timezoneId: 'Europe/London',
		viewport: { width: 1440, height: 2400 }
	});
	const page = await context.newPage();
	let status = null;
	let text = '';
	try {
		const response = await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
		status = response ? response.status() : null;
		await page.waitForTimeout(6000);
		if (check.expandFares) {
			// The walk-up ticket names live behind a per-service "Other tickets" toggle, and
			// the cheapest fare shown up front is usually an Advance. Expanding is what turns
			// a price into a named product.
			for (const control of await page.$$('a, button')) {
				const label = ((await control.innerText().catch(() => '')) || '').trim().toLowerCase();
				if (!label.includes('other tickets')) continue;
				await control.scrollIntoViewIfNeeded().catch(() => {});
				await control.click({ timeout: 4000 }).catch(() => {});
				await page.waitForTimeout(900);
			}
			await page.waitForTimeout(2000);
		}
		text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
	} catch (error) {
		console.log(`         (navigation threw: ${String(error).slice(0, 120)})`);
	}
	await context.close();
	// A refusal wears an error status or arrives as a stub, and either way it is a statement
	// about this probe rather than about the fare. Judging it by its missing strings would
	// report a live citation as stale, which is the mistake this file exists to stop making
	// in the other direction.
	return { status, text, refused: (status !== null && status >= 400) || text.trim().length < 600 };
}

let bad = 0;
let checked = 0;
console.log(`National Rail journeys asked for ${railDate} (DDMMYY)\n`);

for (const check of CHECKS) {
	if (only && check.airport !== only) continue;
	let reading = await read(check);
	if (reading.refused) {
		// One retry, after long enough for a rate limit to forget us. A single 403 is the
		// cheapest kind of false alarm this probe can raise.
		await new Promise((resolve) => setTimeout(resolve, 20000));
		reading = await read(check);
	}
	const { status, text, refused } = reading;

	checked += 1;
	const flat = text.replace(/\s+/g, ' ');
	const missing = check.expect.filter((needle) => !flat.includes(needle.replace(/\s+/g, ' ')));
	const verdict = refused ? 'BLOCKED' : missing.length === 0 ? 'FOUND' : 'CHANGED';
	if (verdict !== 'FOUND') bad += 1;

	console.log(`${verdict.padEnd(8)} ${check.airport}  ${check.claim}`);
	console.log(`         ${check.url}`);
	console.log(`         HTTP ${status ?? '-'}, ${text.length} chars rendered`);
	if (missing.length > 0 && !refused) {
		console.log(`         not on the page: ${missing.map((m) => JSON.stringify(m)).join(', ')}`);
	}
	if (dump) console.log(text.slice(0, 4000).replace(/^/gm, '         | '));
	console.log('');
}

await browser.close();

console.log(`${checked - bad} of ${checked} citations still read as written.`);
if (bad > 0) {
	console.log(
		'A CHANGED row means a citation in transit-fare-table.ts is stale: read the page and\n' +
			'either update the figure or take the airport out. A BLOCKED row means this probe was\n' +
			'turned away, which is not evidence about the fare.'
	);
}
process.exit(bad === 0 ? 0 : 1);
