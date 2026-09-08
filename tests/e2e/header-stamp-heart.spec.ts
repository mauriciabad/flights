import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import {
	mockAllKeylessProviders,
	mockRyanairNetwork,
	routeRyanairFlights
} from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * The date stamp and the save heart, at every width the card is drawn at.
 *
 * Issue #452 put the heart last in the route row rather than in the card's corner, and gave
 * the reason: that is what makes it and the stamp wrap together, which is what stops the
 * dates ending up alone on a line. The reason is right and this file is not an argument
 * against it. What was wrong is that two flex items only travel together while both fit on
 * the line, and the row breaks between them the moment one of them does not.
 *
 * Issue #463 is that break seen on a desktop card. Measured on `main` at e784b4b against a
 * live `?dep=2026-11-10&arr=2026-11-20&from=BCN&to=TLL`, five cards, every viewport width
 * from 320 to 1600:
 *
 * ```
 * Budapest BUD, Hungary            320, 349, 666-693, 942-969, 1306-1333
 * Vienna VIE, Austria              328-341, 636-663, 912-939, 1276-1303
 * Düsseldorf DUS, Germany          320-330, 680-707, 956-983, 1320-1347, 1440-1443
 * Amsterdam AMS, Netherlands       320-334, 707-734, 983-1010, 1347-1374, 1443-1470
 * Frankfurt am Main FRA, Germany   320-334, 739-766, 1015-1023, 1379-1406, 1475-1502
 * ```
 *
 * Every card, four or five bands each, about 28px of viewport wide. Inside a band the stamp
 * fit on the first line and the heart did not, so the heart wrapped on its own and landed at
 * x=361 on a 1440px screen, under the origin flag with the whole card empty to its right.
 * The issue was reported at 1440 on the Düsseldorf card, which is the band at 1440-1443.
 *
 * So the property is not "the heart is somewhere sensible at 375 and at 1440". It is that
 * there is no width at which the two come apart, which is why this sweeps every width in the
 * range rather than sampling the two the report happened to name.
 *
 * On the fixture below, which prints a longer name than any of those five, this test finds 77
 * of 1281 widths on the parent commit, in three bands:
 *
 * ```
 * 320-340px    the stamp at y 624 x 166, the heart at y 656 x 33
 * 1410-1437px  the stamp at y 427 x 912, the heart at y 460 x 329
 * 1506-1533px  the stamp at y 427 x 944, the heart at y 460 x 361
 * ```
 *
 * `.route-end` is what makes it zero: one flex item holding both, so `.route` has nothing to
 * break between, and the `margin-left: auto` that used to sit on the stamp now belongs to the
 * pair. The header measures the same height at every one of the 1281 widths either way,
 * measured card by card on the live search above, so `card-size.spec.ts` keeps its 90 and its
 * 130.
 */

/**
 * Trieste, because the failure is a function of how wide the connection's name is and
 * "Düsseldorf DUS, Germany" is 23 characters.
 *
 * `Ronchi dei Legionari/Trieste TRS, Italy` is 39, the longest label this app can print for
 * an airport Ryanair actually flies to. Its municipality carries no parenthetical and no
 * region suffix, so `cleanMunicipality` leaves it whole (`airport-city-names.ts`), and the
 * card prints all of it. Newcastle upon Tyne is the other 39, and Klagenfurt am Wörthersee
 * the next at 37. The dataset holds longer strings still, up to `Santa Cruz/Graciosa
 * Bay/Luova SCZ, Solomon Islands` at 50, but no airline this app searches flies to any of
 * them, so none can ever be a stopover on a card.
 *
 * A long name is not what makes the defect exist, it is what makes its bands wide. The sweep
 * would find the Vienna bands above too.
 */
const CONNECTION = 'TRS';

/** One stopover, so the card under measurement is the one this file chose. Both ends carry a
 * zone because `ryanair-mapper.ts` drops a fare it cannot date and the city is then refused
 * for a reason that has nothing to do with layout, which is issue #354. */
const NETWORK = [
	{ iataCode: 'BCN', timeZone: 'Europe/Madrid', routes: [`airport:${CONNECTION}`] },
	{ iataCode: CONNECTION, timeZone: 'Europe/Rome', routes: ['airport:BCN', 'airport:TLL'] },
	{ iataCode: 'TLL', timeZone: 'Europe/Tallinn', routes: [`airport:${CONNECTION}`] }
];

const SEARCH_URL = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';

/**
 * Every width from a folding phone to a wide desktop, one pixel at a time.
 *
 * The bands above are about 28px wide and they move with the length of the name, the font and
 * the width of the middle column, none of which this file controls. A sampled set of widths
 * would pass or fail on whether somebody happened to pick 1425, which is the kind of test
 * that goes green the week the type scale changes. The whole test, search and sweep, runs in
 * about 16 seconds.
 */
const NARROWEST_PX = 320;
const WIDEST_PX = 1600;

/** The row's items are 20px, 24px and 25px tall and centred against each other, so their top
 * edges differ by a few pixels inside what is plainly one line. `tools/probe-heart.mjs`
 * compares centres for the same reason and with the same 8px. */
const SAME_LINE_PX = 8;

/** The pair carries the row's only auto margin, so it ends where the row ends. Two pixels for
 * the subpixel width of a bordered box, well under the 24px that would be a real gap. */
const AT_THE_END_PX = 2;

interface HeaderGeometry {
	rowRight: number;
	stampCentre: number;
	stampLeft: number;
	heartCentre: number;
	heartLeft: number;
	heartRight: number;
}

interface Failure {
	width: number;
	what: string;
}

/**
 * The failing widths as the runs of adjacent widths they actually come in.
 *
 * A sweep this fine reports the same break once per pixel, so the parent commit's 77 failures
 * are 77 lines, twenty-one of which say the same thing. That reads as noise rather than as
 * the three bands it is, and where a band starts and how wide it is are the two readings that
 * explain the defect, so those are what the failure prints.
 */
function bands(failures: readonly Failure[]): string[] {
	const runs: string[] = [];
	let first: Failure | undefined;
	let last: Failure | undefined;
	for (const failure of failures) {
		if (first && last && failure.width === last.width + 1) {
			last = failure;
			continue;
		}
		if (first && last) runs.push(`${first.width}-${last.width}px: ${first.what}`);
		first = failure;
		last = failure;
	}
	if (first && last) runs.push(`${first.width}-${last.width}px: ${first.what}`);
	return runs;
}

async function measureHeaders(page: Page): Promise<HeaderGeometry[]> {
	return page.locator('.result-card').evaluateAll((cards) =>
		cards.map((card) => {
			const box = (selector: string) => {
				const element = card.querySelector(selector);
				if (!element) throw new Error(`no ${selector} on a result card`);
				return element.getBoundingClientRect();
			};
			const row = box('.route');
			const stamp = box('.route-dates');
			const heart = box('.save-trip');
			return {
				rowRight: row.right,
				stampCentre: stamp.top + stamp.height / 2,
				stampLeft: stamp.left,
				heartCentre: heart.top + heart.height / 2,
				heartLeft: heart.left,
				heartRight: heart.right
			};
		})
	);
}

test.describe('the header stamp and the heart', () => {
	test('travel together at every width', async ({ page }) => {
		await mockAllKeylessProviders(page.context());
		await mockRyanairNetwork(page.context(), NETWORK);
		await routeRyanairFlights(
			page.context(),
			[
				{
					dep: 'BCN',
					arr: CONNECTION,
					depDate: '2027-03-08T08:00:00',
					arrDate: '2027-03-08T10:15:00',
					price: FIXTURE_PRICES.first,
					flightNumber: FIXTURE_FLIGHT_NUMBERS[0]
				},
				{
					dep: CONNECTION,
					arr: 'TLL',
					depDate: '2027-03-11T11:00:00',
					arrDate: '2027-03-11T13:20:00',
					price: FIXTURE_PRICES.second,
					flightNumber: FIXTURE_FLIGHT_NUMBERS[1]
				}
			],
			{ airports: NETWORK }
		);

		await page.setViewportSize({ width: WIDEST_PX, height: 1400 });
		await page.goto(SEARCH_URL);
		await waitForSearchToSettle(page, { timeout: 20_000 });
		await expect(page.locator('.result-card').first()).toBeVisible();

		// The premise, before the sweep that depends on it. A card whose stopover resolved to
		// a bare "TRS" would pass every assertion below while measuring a 7-character label,
		// which is issue #382's shape: a geometry check that an empty case satisfies.
		await expect(page.locator('.result-card .route-leg-stopover .place').first()).toHaveText(
			'Ronchi dei Legionari/TriesteTRS, Italy'
		);

		const orphaned: Failure[] = [];
		const adrift: Failure[] = [];
		for (let width = NARROWEST_PX; width <= WIDEST_PX; width++) {
			await page.setViewportSize({ width, height: 1400 });
			for (const header of await measureHeaders(page)) {
				if (Math.abs(header.stampCentre - header.heartCentre) > SAME_LINE_PX) {
					orphaned.push({
						width,
						what:
							`the stamp at y ${Math.round(header.stampCentre)} x ${Math.round(header.stampLeft)}, ` +
							`the heart at y ${Math.round(header.heartCentre)} x ${Math.round(header.heartLeft)}`
					});
				}
				if (header.rowRight - header.heartRight > AT_THE_END_PX) {
					adrift.push({
						width,
						what:
							`the heart ends at x ${Math.round(header.heartRight)}, the row at ` +
							`x ${Math.round(header.rowRight)}`
					});
				}
			}
		}

		expect(
			bands(orphaned),
			`The heart left the line its stamp is on at ${orphaned.length} of the ` +
				`${WIDEST_PX - NARROWEST_PX + 1} widths swept. Issue #452 asked for the two to wrap ` +
				'together and issue #463 is what it takes: one flex item, so the row cannot break ' +
				'between them.'
		).toEqual([]);

		expect(
			bands(adrift),
			`The heart is not at the end of its line at ${adrift.length} of the ` +
				`${WIDEST_PX - NARROWEST_PX + 1} widths swept. The pair carries the row's only auto ` +
				"margin, so whichever line it lands on, it ends it."
		).toEqual([]);
	});
});
