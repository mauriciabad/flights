import { expect, test } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #288: "the female-traveller count changes nothing". The search form promises to
 * "check whether female-only hostel dorms are available for your group", and the two
 * searches below are the issue's own proof that it did not - same URL twice, `females` the
 * only thing that differs, and a stay panel that has to come out different.
 *
 * The fixture property is shaped like the ones a real Hostelworld page carries. Its every
 * listed dorm is gender-restricted (one female, one male) while its property-level
 * `lowestAverageDormPricePerNight` still quotes an unqualified dorm rate - 10 of Rome's 30
 * properties, 2 of Berlin's and 1 of London's look exactly like this on a live page
 * (`tools/probe-female-dorms.mjs`, 2026-09-05). The London one is "Hostelle - women only
 * hostel London", which is issue #207's own property.
 *
 * Before the fix that property-level figure became a "Dorm bed" tile: cheapest, always
 * selectable, identical for every party. It is why the panel could not move when `females`
 * did. So the assertion that matters most here is the negative one - no "Dorm bed" at a
 * property that lists no mixed dorm - and it is asserted in both runs.
 *
 * The unit tests in `src/lib/providers/stays/hostelworld-mapper.test.ts` cover the mapping
 * itself against a real captured Rome page. What they cannot show is a traveller looking at
 * two tiles and seeing which one they may click, which is the thing #288 was filed about.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** The trip: one Vienna stopover with a night in it, so the stay picker has something to
 * price. Same pair `keyless-bed.spec.ts` uses. */
async function searchWithFemales(page: import('@playwright/test').Page, females: number) {
	await mockAllKeylessProviders(page.context());
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna-restricted-dorms.json'
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

	await page.goto(
		`/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL&people=2&females=${females}`
	);
	await waitForSearchToSettle(page, { timeout: 30_000 });

	await expect(page.locator('.result-card').first()).toBeVisible();
	// The timeline preview's own caption is what unfolds the full timeline since #278.
	await page.getByRole('button', { name: /show the full timeline/ }).first().click();
	// The stopover row in the timeline. Located by `data-segment` rather than by label,
	// because the row carries `aria-roledescription="selectable step"` and a role query
	// does not reach it. `free-time` is the segment `ResultDetail.svelte` puts the stay
	// picker under. Scoped to the page, not to `.result-card`: the detail panel renders as
	// the card's sibling, below it, rather than inside it.
	await page.locator('li[data-segment="free-time"]').first().click();

	const tiles = page.locator('.stay-room-kinds').first();
	await expect(tiles).toBeVisible();
	return tiles;
}

test.describe('the female-traveller count decides which dorms a group is offered (issue #288)', () => {
	test('a party with no female travellers is barred from the female dorm and offered the male one', async ({
		page
	}) => {
		const tiles = await searchWithFemales(page, 0);

		// The fabricated bed. `lowestAverageDormPricePerNight` is set on this property and
		// no mixed dorm is listed, so before the fix this tile was here, enabled, cheapest
		// and picked - for every value of `females` alike.
		await expect(tiles.getByRole('button', { name: /Dorm bed/ })).toHaveCount(0);

		const female = tiles.getByRole('button', { name: /Female-only dorm/ });
		await expect(female).toBeDisabled();
		await expect(female).toContainText('no female travellers');

		// The mirror, and the reason a male dorm needed a kind of its own: two men can book
		// this one, and before the fix it was labelled "Dorm bed" for everybody.
		await expect(tiles.getByRole('button', { name: /Male-only dorm/ })).toBeEnabled();
	});

	test('an all-female party is offered the female dorm and barred from the male one', async ({
		page
	}) => {
		const tiles = await searchWithFemales(page, 2);

		await expect(tiles.getByRole('button', { name: /Dorm bed/ })).toHaveCount(0);
		await expect(tiles.getByRole('button', { name: /Female-only dorm/ })).toBeEnabled();

		const male = tiles.getByRole('button', { name: /Male-only dorm/ });
		await expect(male).toBeDisabled();
		await expect(male).toContainText('no male travellers');
	});
});
