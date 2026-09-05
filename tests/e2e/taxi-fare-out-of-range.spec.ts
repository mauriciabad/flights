import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockOsrm, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline } from './support/results-ui';

/**
 * Issue #246, in a real browser against a real build, which is where this bug lived and
 * where its unit tests could not see it. Production quoted a 95 km airport transfer at
 * £268.75-£430.90, more than twice the flight it connects to, because a per-kilometre
 * figure back-calculated from a 5 km London ride was applied linearly to a motorway run.
 *
 * The only thing this spec changes from the ordinary keyless setup is the OSRM route
 * length: 94.9 km instead of `osrm/route.json`'s 18.3 km. Everything else, including the
 * search that reaches the picker, is the path a traveller takes. The default fixture stays
 * inside the rated range on purpose, so every other spec keeps exercising the priced
 * branch and this one exercises the refusal.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('a transfer longer than the rate cards cover (issue #246)', () => {
	test('shows the ride, refuses the fare, and says which distance it is refusing', async ({ page }) => {
		await mockAllKeylessProviders(page.context());
		// Registered after the batch above, so this wins: Playwright asks the
		// most-recently-registered matching route first.
		await mockOsrm(page.context(), 'osrm/route-long.json');

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
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
		await openTimeline(page);

		const detail = page.locator('.result-detail');
		const hotelRow = detail.locator('.itinerary-timeline [data-segment="transfer-to-hotel"]');
		await hotelRow.click();

		// Issue #278: picking the row fills the customise rail beside the list rather
		// than unfolding a picker inside the row.
		const taxiRow = customiser(page).locator('.picker-row', { hasText: 'Taxi' }).first();
		await expect(taxiRow).toBeVisible();

		// The duration is a real measurement and stays: OSRM's 4560 seconds, and nothing else.
		// It read 1h 46m until issue #290, because the 30-minute landing-to-transport buffer
		// `applyLandingBuffer` adds was folded in and then labelled as the taxi. The buffer is
		// still spent, and now says so on its own line above the list. Only the fare is
		// withheld.
		await expect(taxiRow.locator('.row-duration')).toContainText('1h 16m');
		await expect(taxiRow.locator('.row-duration')).not.toContainText('1h 46m');
		await expect(customiser(page).locator('.picker-landing-buffer')).toContainText(
			'Every option here starts 30m after you land'
		);

		const price = taxiRow.locator('.row-price');
		await expect(price).toContainText('No fare estimate');
		// The regression itself: no currency figure anywhere in the cell that used to
		// carry "£268.75-£430.90".
		await expect(price).not.toContainText(/[£€$]/);

		await expect(taxiRow).toContainText('Why there is no fare estimate');
		await expect(taxiRow).toContainText('95 km is past the city rate card');
		await expect(taxiRow).toContainText('covers rides up to 30 km');
	});
});
