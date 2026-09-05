import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockOsrm, routeRyanairFlights } from './support/providers';

/**
 * Issue #119's second half, in a real browser against a real build.
 *
 * The fixture is the Athens-to-Naxos measurement behind `maxPlausibleRoadMinutes`, scaled
 * onto this suite's Vienna pair: 180 km of road in 33 hours, which is what OSRM's car
 * profile returns whenever a `route=ferry` way carries no `duration` tag and falls back to
 * about 5 km/h. Nothing else changes from the ordinary keyless setup, and the default
 * `osrm/route.json` stays a believable 18.3 km so every other spec keeps exercising the
 * branch where a road transfer is offered.
 *
 * Two things have to hold together, and only a real page can show both at once. The rows a
 * traveller can click must not contain the refused ride — "dont even show this" is not
 * satisfied by a row that merely lost the ranking — and the leg must say what happened,
 * because "no transport provider could route to it" is false about a route a provider
 * returned.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('a road route too slow for the distance (issue #119)', () => {
	test('drops the ride from every row and says what was refused', async ({ page }) => {
		await mockAllKeylessProviders(page.context());
		// Registered after the batch above, so this wins: Playwright asks the
		// most-recently-registered matching route first.
		await mockOsrm(page.context(), 'osrm/route-implausible.json');

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
		await page.getByRole('button', { name: 'Show details' }).first().click();

		const detail = page.locator('.result-detail');
		const hotelRow = detail.locator('.itinerary-timeline [data-segment="transfer-to-hotel"]');
		await expect(hotelRow).toBeVisible();

		// The row a traveller reads. It used to be able to say only that nobody could route
		// this leg, which is not what happened.
		await expect(hotelRow).toContainText('The road route in takes 33h to cover 18 km in a straight line');
		await expect(hotelRow).not.toContainText('no transport provider could route');

		// And the refusal reaches the options, not only the pick. A 33-hour drive must not be
		// sitting one click away under any label.
		await hotelRow.click();
		await expect(detail.locator('.picker-row', { hasText: 'Drive' })).toHaveCount(0);
		await expect(detail.locator('.picker-row', { hasText: 'Taxi' })).toHaveCount(0);
		await expect(detail).not.toContainText('33h 0m');
	});
});
