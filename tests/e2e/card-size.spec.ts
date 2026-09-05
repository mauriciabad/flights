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
 * ## Why 620, and what it costs
 *
 * 620px is what a phone has under the app header and the tab bar, so the ceiling is the
 * screen rather than a number somebody liked. On this fixture the card measures 598px,
 * which leaves 22px: enough to absorb a font metric shifting a line, nowhere near the 54px
 * of the smallest whole block this card has ever gained.
 *
 * It was 520 for about an hour, which is the honest history. #278 took the card from 752px
 * to 492px, and then #287 landed `FlightDetour` on it, an 80px drawing plus its 12px gap.
 * That is a deliberate addition by somebody who measured it, and nothing left on the
 * collapsed card duplicates it: the price receipt, the trip strip and the totals rail each
 * answer a different question, and the detour is the only thing on the card that answers
 * "how far out of the way is this". The `Nights` figure `PickedBed` prints beside the
 * strip's own would have been the thing to spend, and it is not on the collapsed card at
 * all: it is in the timeline, which is unfolded or not there. So the ceiling goes up rather
 * than something else coming off, and the numbers are here so the next reader sees a trade
 * instead of discovering one.
 *
 * The parts, measured at 375px: header 90, price receipt 86, trip strip 79, flight detour
 * 80, totals rail 143, footer 58, plus 60px of gaps and padding.
 *
 * Raising this number again is a decision somebody makes on purpose, in a diff a reviewer
 * sees. The absolute figures are this fixture's, not the owner's: his route line fits one
 * row where BCN to Vienna to Tallinn takes two, and his free-time figure does not wrap.
 */
const CARD_HEIGHT_BUDGET_PX = 620;

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('result card size', () => {
	test('one card still fits a phone screen', async ({ page }) => {
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
