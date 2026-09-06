import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import {
	mockAllKeylessProviders,
	mockTransitousPerLegMoment,
	routeRyanairFlights
} from './support/providers';
import { customiser, openTimeline, pickTimelineSegment } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #407: "the price on the public transport is missing. there should be an estimate."
 *
 * A unit test cannot see this one. The fare card is keyed by airport, the party comes out of
 * the URL, the currency comes off the itinerary's own total and the boarding count comes off
 * whatever the timetable answered, and those four are assembled across a provider adapter, a
 * search step and a Svelte closure. `transit-fare-table.test.ts` next door proves the
 * arithmetic against arguments it supplies itself, which is exactly the gap issue #356's
 * spec was written for one leg over.
 *
 * The origin leg rather than a stopover leg, because Barcelona is in the fare table and the
 * scenario's stopover cities are not, and because it needs no bed: the defect is about the
 * fare, not about the bed.
 */

const BCN_VIE_TLL = [
	{
		dep: 'BCN',
		arr: 'VIE',
		depDate: '2027-03-08T08:00:00',
		arrDate: '2027-03-08T10:15:00',
		price: FIXTURE_PRICES.first,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[7]
	},
	{
		dep: 'VIE',
		arr: 'TLL',
		depDate: '2027-03-10T11:00:00',
		arrDate: '2027-03-10T13:20:00',
		price: FIXTURE_PRICES.third,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[8]
	}
];

/**
 * TMB's own 2026 fare table, read on 2026-09-06: an integrated 1-zone single is €2.90 and
 * the Bitllet Aeroport is €5.90. Written out rather than imported so an edit to the rate
 * card fails this spec loudly instead of quietly agreeing with whatever the code now says,
 * the same choice `swapped-bed-fare.spec.ts` makes about the Austrian taxi card.
 */
const BARCELONA_TICKET = '€2.90-€5.90';

test.describe('a public-transport leg carries a ticket price (issue #407)', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('the ride to the origin airport is priced from the city that sells the ticket', async ({
		page
	}) => {
		await mockAllKeylessProviders(page.context());
		// The origin leg asks `arriveBy=true`, since being at the airport by check-in is a
		// deadline rather than a departure. The blanket mock answers both questions with the
		// same body, which would put a departure two days out on a leg leaving today.
		await mockTransitousPerLegMoment(page.context());
		await routeRyanairFlights(page.context(), BCN_VIE_TLL);

		await page.goto(
			'/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL' +
				'&fromLoc=' +
				encodeURIComponent('FIXTURE start point@41.3851,2.1734')
		);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		await openTimeline(page);
		const toAirport = page.locator('.result-detail [data-segment="transfer-to-origin-airport"]');

		// The timeline names the vehicle the timetable answered with, where the picker names
		// the mode. "Bus" here and "Public transport" in the test below are the same leg.
		await expect(toAirport).toContainText('Bus');
		// The whole issue on one row. Before this it read "price n/a", because no provider in
		// this codebase quotes a bus fare and nothing estimated one.
		await expect(toAirport).toContainText(BARCELONA_TICKET);
		await expect(toAirport).not.toContainText('price n/a');
	});

	test('the picker calls it an estimate and names the operator it came from', async ({ page }) => {
		await mockAllKeylessProviders(page.context());
		await mockTransitousPerLegMoment(page.context());
		await routeRyanairFlights(page.context(), BCN_VIE_TLL);

		await page.goto(
			'/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL' +
				'&fromLoc=' +
				encodeURIComponent('FIXTURE start point@41.3851,2.1734')
		);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		await openTimeline(page);
		await pickTimelineSegment(page, 'transfer-to-origin-airport');

		const busRow = customiser(page).locator('.picker-row', { hasText: 'Public transport' });
		await expect(busRow).toContainText(BARCELONA_TICKET);
		// AGENTS.md, "never present an estimate as a fact". A range with no tag on it is a
		// number a traveller reads as a quote.
		await expect(busRow).toContainText('estimate');

		// And the citation, which is the difference between a figure and a researched figure.
		const citation = busRow.locator('.fare-citation');
		await expect(citation).toBeVisible();
		await citation.locator('summary').click();
		await expect(citation).toContainText('tmb.cat');
	});
});
