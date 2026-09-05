import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';

/**
 * How tall one result card is on a 375px phone, asserted rather than remembered.
 *
 * Issue #197 brought the card down to 462px and wrote the number in a comment. Issue #232
 * then added a price band, #225 a "staying longer" ladder and #210 a technical-stop note,
 * each of them measured against that comment by whoever happened to read it. By the time
 * issue #278 opened, the card was back over 540px against the roughly 620px a phone has
 * under the header and the tab bar, and nothing in the suite had noticed.
 *
 * So the budget lives here. A card taller than `CARD_HEIGHT_BUDGET_PX` means one screen
 * holds one card, which is the state issue #197 fixed and #278 fixed again: comparing two
 * trips is the whole job of this screen.
 *
 * ## Why 520 and not the measurement
 *
 * On this fixture the card was 646px before #278 and is 492px after it, so this is a
 * ceiling with 28px under it rather than a pin. That gap is deliberate. The failure this
 * guards against is a whole block arriving on the card, and the smallest block that ever
 * did was the 54px control row; a font metric shifting a line by three pixels is not a
 * regression and must not read as one.
 *
 * The absolute numbers are this fixture's, not the owner's. His own route measured about
 * 549px before this change, because his route line fits on one row where BCN to Vienna to
 * Tallinn takes two, and his free-time figure does not wrap. The 154px this change takes
 * off applies to both.
 *
 * Raising this number is a decision somebody makes on purpose, in a diff a reviewer sees.
 */
const CARD_HEIGHT_BUDGET_PX = 520;

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('result card size', () => {
	test('one card fits a phone screen twice over', async ({ page }) => {
		await mockAllKeylessProviders(page.context());
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
				dep: 'BCN',
				arr: 'VIE',
				depDate: '2027-03-09T16:30:00',
				arrDate: '2027-03-09T18:45:00',
				price: FIXTURE_PRICES.second,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[3]
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

		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();

		const height = await card.evaluate((element) => element.getBoundingClientRect().height);
		console.log(`result card at 375px: ${Math.round(height)}px`);
		expect(Math.round(height)).toBeLessThanOrEqual(CARD_HEIGHT_BUDGET_PX);
	});
});
