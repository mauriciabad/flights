import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #356: the ride to a bed you swapped to has to carry a fare, the same way the ride
 * to the bed the search picked does.
 *
 * `routeToProperty` passed neither the connection's country nor the traveller's currency,
 * and `osrm.ts` reads both off the query: no country, no rate card, and the taxi comes back
 * with no `fareEstimate` at all. So one screen showed a priced ride to one bed and
 * "Price not available" for the ride to the next, and issue #319's whole panel is built to
 * compare those two side by side.
 *
 * No unit test can see this. The arguments are assembled in a `.svelte` closure, which is
 * the same place issue #158's missing currency hid, and `route-to-property.test.ts` next
 * door passed throughout because it supplies its own input. So this drives the swap.
 *
 * Both beds are deliberately beyond `MAX_WALK_ROUTE_DISTANCE_KM`, because a walk is free
 * and needs no rate card. A bed you can walk to hides the defect completely, which is why
 * `itinerary-editing.spec.ts` swaps to one and never saw this.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** What the OSRM fixture's 18.3 km comes to on Austria's card: €3.80-€4.80 to drop the
 * flag plus €1.40-€1.90 a km. Written out so a rate-card edit fails this test loudly
 * rather than quietly agreeing with whatever the code now says. */
const AUSTRIAN_TAXI_FARE = '€29.42-€39.57';

test.describe('a bed you swap to keeps its fare (issue #356)', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('the ride to a swapped bed is priced, like the ride to the bed the search picked', async ({
		page
	}) => {
		await mockAllKeylessProviders(page.context());
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna-both-far.json'
		);
		await routeRyanairFlights(page.context(), [
			{
				dep: 'BCN',
				arr: 'VIE',
				depDate: '2027-03-08T08:00:00',
				arrDate: '2027-03-08T10:15:00',
				price: FIXTURE_PRICES.first,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[2]
			},
			{
				dep: 'VIE',
				arr: 'TLL',
				depDate: '2027-03-10T11:00:00',
				arrDate: '2027-03-10T13:20:00',
				price: FIXTURE_PRICES.third,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
			}
		]);
		// No bus, so the taxi is what the app picks for both beds. Transitous answering with
		// a service would make the search's own leg a bus and hide the very comparison this
		// test is about, since a timetabled fare and a rate-card estimate are different
		// answers to different questions.
		await page.context().route('https://api.transitous.org/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: '{"itineraries":[]}' })
		);
		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await waitForSearchToSettle(page, { timeout: 20_000 });

		await openTimeline(page);
		const toBed = page.locator('.result-detail [data-segment="transfer-to-hotel"]');

		// The search's own bed, and the reading this test compares everything against. The
		// pipeline passes the country and the currency, so this ride has always been priced.
		await expect(toBed).toContainText('Taxi');
		await expect(toBed).toContainText(AUSTRIAN_TAXI_FARE);

		// Two taps to the other bed: open the stopover, pick the other property.
		await page.locator('.result-detail [data-segment="free-time"]').click();
		const otherBed = customiser(page).locator('.alt-card', { hasText: 'FIXTURE Far Lodge' });
		await expect(otherBed).toBeVisible();
		await otherBed.click();

		// The whole issue, on the timeline row a traveller reads while comparing the two.
		// Before the fix this row said "price n/a" on a ride the same screen had priced a tap
		// earlier, which makes the bed at the end of it look cheaper than it is.
		await expect(page.locator('.result-detail .stopover')).toContainText('FIXTURE Far Lodge');
		await expect(toBed).toContainText('Taxi');
		await expect(toBed).toContainText(AUSTRIAN_TAXI_FARE, { timeout: 15_000 });
		await expect(toBed).not.toContainText('price n/a');

		// And in the picker, which is where issue #282 reported the estimate and where the
		// row is tagged as a guess rather than a quote.
		await page.locator('.result-detail [data-segment="transfer-to-hotel"]').click({
			position: { x: 6, y: 6 }
		});
		const currentPick = customiser(page).locator('.picker-row.is-selected');
		await expect(currentPick).toContainText(AUSTRIAN_TAXI_FARE);
		await expect(currentPick).toContainText('estimate');
	});
});
