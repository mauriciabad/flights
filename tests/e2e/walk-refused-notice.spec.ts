import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import {
	mockAllKeylessProviders,
	mockHostelworld,
	OSRM_BASE_URL,
	routeRyanairFlights
} from './support/providers';
import { customiser, openTimeline } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #347, in a real browser against a real build.
 *
 * #348 moved every ground transfer's start onto a real terminal and fixed 3,096 airports.
 * 653 have no `aeroway=terminal` mapped within 6 km of the published point, so at those the
 * walk still starts at the runway reference point and can come back at Gatwick's 1h 13m for
 * a bed that is a few minutes away. This spec is that airport: the foot route answers 73
 * minutes wherever it is asked from, which is what an unmapped airport looks like from
 * inside the app.
 *
 * The shape that makes this worth a browser is the one a unit test cannot hold together.
 * The drive is fine, so the leg IS routed, the timeline row shows the drive, and
 * `unroutedLegNote` never runs. Everything about the refused walk was correct and invisible.
 * So the assertions are about two surfaces at once: the card stays quiet, and the picker
 * behind the tap says what happened.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** Over `MAX_PLAUSIBLE_WALK_MINUTES`, and Gatwick's own measured number. */
const REFUSED_WALK_MINUTES = 73;

function osrmWalk(minutes: number) {
	return JSON.stringify({
		code: 'Ok',
		waypoints: [
			{ hint: 'FIXTURE-origin', distance: 4.2, name: '', location: [16.5697, 48.1103] },
			{ hint: 'FIXTURE-destination', distance: 8.1, name: '', location: [16.3738, 48.2082] }
		],
		routes: [
			{
				geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
				legs: [{ steps: [], summary: '', weight: 1, duration: minutes * 60, distance: minutes * 75 }],
				weight_name: 'routability',
				weight: 1,
				duration: minutes * 60,
				distance: minutes * 75
			}
		]
	});
}

test.describe('a walk refused for a bed that is close by (issue #347)', () => {
	test('keeps the card quiet and says what was refused behind the tap', async ({ page }) => {
		await mockAllKeylessProviders(page.context());
		// The bed #348's spec uses: 2.5 km north of Vienna's terminal, inside the 4.5 km
		// radius `osrm.ts` will ask for a foot route within. So a walk really is requested
		// here, which is the precondition for it being refused rather than skipped.
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna-walkable.json'
		);

		// Foot only. Driving falls through to the default fixture, 18.3 km in 27 minutes,
		// comfortably inside `maxPlausibleRoadMinutes` for this leg — so the leg keeps a
		// transfer and the timeline never reaches its unrouted row.
		await page.context().route(`${OSRM_BASE_URL}/routed-foot/**`, (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: osrmWalk(REFUSED_WALK_MINUTES)
			})
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

		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await waitForSearchToSettle(page, { timeout: 20_000 });
		await openTimeline(page);

		const hotelRow = page.locator('.itinerary-timeline [data-segment="transfer-to-hotel"]');
		await expect(hotelRow).toBeVisible();

		// The card is where a refusal turns into noise, so it says nothing. The leg has a
		// drive and the row shows the drive, exactly as it did before this change.
		await expect(hotelRow).not.toContainText('not offered');
		await expect(hotelRow).not.toContainText('1h 13m');

		await hotelRow.click();

		// The refused walk is not one click away under any label, which is issue #119's
		// "dont even show this" applied to the mode it was never applied to.
		await expect(customiser(page).locator('.picker-row', { hasText: 'Walk' })).toHaveCount(0);

		// And the traveller can now tell that from nobody having measured a walk at all.
		const notice = customiser(page).getByTestId('walk-notice');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText('Walking was checked');
		await expect(notice).toContainText('1h 13m');
		// The distance is the half that makes it actionable: 1h 13m to cross 3 km is a route
		// measured from the wrong side of a runway, and a traveller in the terminal can see
		// that even though this app cannot.
		await expect(notice).toContainText('km in a straight line');
	});
});
