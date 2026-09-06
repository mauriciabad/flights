import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { customiser, pickStripSegment } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #317, on the real page rather than on a mounted component.
 *
 * Measured on production first, at 1280x900 against
 * `flights.mauri.app/results/?arr=2026-10-12&dep=2026-10-06&from=BCN&to=PFO`: the outbound
 * picker listed thirteen flights across four dates, printed a clock reading and nothing
 * else on every row, and priced six of them under their own sentence saying the onward
 * flight leaves before that one lands. Flight VY6500 at 7:20am appeared four times, at
 * EUR 55, 41, 67 and 82, and the rows were indistinguishable.
 *
 * `FlightPicker.test.ts` asserts the same two rules against a mounted component. This one
 * proves the wiring: that the alternatives the real pipeline hands the real picker still
 * arrive spanning several dates, and that the panel a traveller opens off the trip strip
 * is the one carrying the fix. AGENTS.md is blunt about why both are needed. A defect that
 * "survived 849 passing unit tests and a fully green deploy" is what that section is about.
 *
 * ## The fixture, and why it has four flights rather than three
 *
 * Two outbound-and-onward pairings, a fortnight apart. The late pairing's outbound lands on
 * 12 March, and the onward the card is currently on left on 10 March. That cross-pairing is
 * the row production printed a price on, and three flights on one connection cannot produce
 * it.
 *
 * ## What issue #387 changed underneath this spec, and what it did not
 *
 * The rule #317 established is that **a row the app has ruled out must not be priced**. That
 * rule is untouched. What changed is how often a row is ruled out at all: a picker row is a
 * whole pairing now, so the 12 March outbound is previewed against the 14 March onward that
 * goes with it rather than against an onward that left two days before it lands. The row is
 * a real trip, so it is priced, and that is correct.
 *
 * The two tests below therefore assert the new truth on this fixture. #317's own rule is
 * still proved, in the two places where a row can still be unusable: `FlightPicker.test.ts`
 * mounts the component with no companion at all, and `departure-ladder.spec.ts` reaches it
 * on the real page the only way a traveller now can, by pinning an onward flight that the
 * outbound cannot meet.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

const RESULTS_URL = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';

test.describe('alternative flights across several dates (issue #317)', () => {
	test.beforeEach(async ({ page }) => {
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
				dep: 'VIE',
				arr: 'TLL',
				depDate: '2027-03-10T11:00:00',
				arrDate: '2027-03-10T13:20:00',
				price: FIXTURE_PRICES.third,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
			},
			// The late pairing. Its outbound is the row that cannot reach the 10 March
			// onward, which is the row production priced.
			{
				dep: 'BCN',
				arr: 'VIE',
				depDate: '2027-03-12T16:30:00',
				arrDate: '2027-03-12T18:45:00',
				price: FIXTURE_PRICES.second,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[3]
			},
			{
				dep: 'VIE',
				arr: 'TLL',
				depDate: '2027-03-14T11:00:00',
				arrDate: '2027-03-14T13:20:00',
				price: FIXTURE_PRICES.third,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[5]
			}
		]);
		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto(RESULTS_URL);
		await waitForSearchToSettle(page, { timeout: 20_000 });
		await expect(page.locator('.result-card').first()).toBeVisible();
		await pickStripSegment(page, 'flight');
		await expect(customiser(page).getByRole('radiogroup', { name: /Outbound/ })).toBeVisible();
	});

	test('every row says which day it is on', async ({ page }) => {
		const picker = customiser(page).getByRole('radiogroup', { name: /Outbound/ });
		const rows = picker.locator('.picker-row');

		// The caption's own claim about the list, which is what makes the per-row date due.
		// It is a sibling of the radio group, not a child of it: `FlightPicker` puts it above
		// the list so a screen reader hears the group's own label rather than this sentence.
		await expect(customiser(page).locator('.picker-provenance').first()).toContainText(
			'across 2 dates'
		);

		const count = await rows.count();
		expect(count).toBeGreaterThan(1);
		for (let index = 0; index < count; index++) {
			await expect(rows.nth(index).locator('.row-date')).toHaveText(
				/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}$/
			);
		}
	});

	test('the row that could not connect is a trip now, on the onward flight that goes with it', async ({
		page
	}) => {
		// Issue #387. This row is the one production priced under its own sentence saying no
		// such connection exists. It is not ruled out any more, because the app looks up the
		// onward flight that pairs with this outbound instead of leaving the old one in place.
		const picker = customiser(page).getByRole('radiogroup', { name: /Outbound/ });
		const late = picker.locator('.picker-row', { hasText: FIXTURE_FLIGHT_NUMBERS[3] });

		await expect(picker).not.toContainText('no connection to make');
		await expect(late.locator('.row-price')).toHaveCount(1);
		await expect(late.locator('.delta-text')).toHaveCount(1);
		// Said before the press: this row's price is a whole trip's, and the onward leg is
		// part of what moved to make that trip exist.
		await expect(late.locator('.row-companion')).toContainText('different onward flight');
	});

	test('every row keeps the comparison it exists for', async ({ page }) => {
		const picker = customiser(page).getByRole('radiogroup', { name: /Outbound/ });
		const rows = picker.locator('.picker-row');

		await expect(rows).toHaveCount(2);
		await expect(picker.locator('.row-current')).toHaveText('Current pick');
		await expect(picker.locator('.delta-text')).toHaveCount(1);
	});
});
