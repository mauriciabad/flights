import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * `docs/ACCEPTANCE.md` condition 3, "A bed is priced into the total", for a visitor who has
 * pasted in nothing.
 *
 * That condition could not pass without a key until `providers/stays/hostelworld.ts`
 * existed: Agoda and Booking are both `needsKey: true`, so `resources.ts`'s
 * `isProviderUsable` filtered them out before a request left the browser and every stopover
 * on the page read "No bed priced for this stopover".
 *
 * The QA suite's own bed check calls `withKeys()` first, so it proves a KEYED visitor gets a
 * bed and says nothing about this one. Nothing else in the repo fails if the keyless adapter
 * is unregistered, which is what this file is for. It asserts the absence of that sentence
 * rather than a figure, because the figure belongs to the mock and the sentence is what the
 * owner reported seeing.
 *
 * No key is written anywhere in this test on purpose. `mockAllKeylessProviders` is the
 * empty-key-store state issue #18 describes, and the assertion below is only meaningful
 * from it.
 *
 * Prices come from `support/fixture-markers.ts`, so a bed here costs €9,444.44 a night and
 * could never be mistaken for a real answer if this fixture ever escaped the test.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('a bed is priced with no key at all (ACCEPTANCE.md condition 3)', () => {
	test('a stopover gets a bed price from the keyless stay provider, with an empty key store', async ({
		page
	}) => {
		await mockAllKeylessProviders(page.context());

		// Registered after the defaults so this wins: Hostelworld answers with one city at
		// Vienna airport's own coordinates and one property sitting on it, which is what the
		// real adapter's radius filter needs to keep anything at all.
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna.json'
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

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();
		await expect(card).toContainText('VIE');

		// The sentence issue #117 is about. Its absence is the whole deliverable: no key was
		// ever written in this test, and a bed was still priced into the total.
		await expect(card).not.toContainText('No bed priced');
	});
});
