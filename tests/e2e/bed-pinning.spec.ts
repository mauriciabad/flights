import type { Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline, pickTimelineSegment } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #367: changing the length of a stopover re-optimises the bed, and a bed the
 * traveller picked survives it.
 *
 * The owner's case, verbatim: "if I pick 1 night or 2 nights, the recommended hotel should
 * change, because I have free time and a closer to the center is more desirable." Nothing
 * in jsdom can check it. The bed moves because a click handler rebuilds the trip and starts
 * a fetch, the announcement is a live region, and the mark that says whose bed it is sits
 * three components below the state that decides it.
 *
 * ## The fixture is tuned so the answer actually moves
 *
 * Two beds €38.88 a night apart: the cheaper one on the terminal, the dearer one on
 * Vienna's own centre 18.3 km away. `stays/stopover-cost.ts` charges the ride out to a bed
 * twice whatever the length, and a ride into town once per day there is a day to spend
 * there, so the terminal bed wins the one-night trip by €38.88 and the central one wins the
 * three-night trip by €37.08. Both flights are timed to pin the day count the crossover
 * turns on: one usable afternoon on the short trip, two whole days and two usable edges on
 * the long one.
 *
 * The second test is a loss of work that predates this issue. `setWaitingTime` bypasses
 * `draft.apply` on purpose (issue #135) and `chooseNights` replaces the draft, so an
 * airport buffer somebody typed used to vanish the moment they pressed the nights ladder.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

const TERMINAL_BED = 'FIXTURE Terminal Lodge';
const CENTRAL_BED = 'FIXTURE Central Lodge';

/**
 * One outbound landing at Vienna at midday and two ways out: the next morning, or three
 * days later. The card opens on the cheaper of those, which is the short one, since two
 * more nights cost another €18,811.12 of bed whatever the fares do.
 */
async function searchWithTwoLengths(page: Page) {
	await mockAllKeylessProviders(page.context());
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna-crossover.json'
	);
	await routeRyanairFlights(page.context(), [
		{
			dep: 'BCN',
			arr: 'VIE',
			depDate: '2027-03-08T09:45:00',
			arrDate: '2027-03-08T12:00:00',
			price: FIXTURE_PRICES.first,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[2]
		},
		{
			dep: 'VIE',
			arr: 'TLL',
			depDate: '2027-03-09T09:00:00',
			arrDate: '2027-03-09T10:20:00',
			price: FIXTURE_PRICES.third,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
		},
		{
			dep: 'VIE',
			arr: 'TLL',
			depDate: '2027-03-11T16:00:00',
			arrDate: '2027-03-11T17:20:00',
			price: FIXTURE_PRICES.third,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[5]
		}
	]);
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);

	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await waitForSearchToSettle(page, { timeout: 20_000 });
	await openTimeline(page);
}

test.describe('a longer stopover re-picks the bed, and a chosen bed keeps its place', () => {
	test('the app moves a recommended bed, says so, and the traveller can take it back', async ({
		page
	}) => {
		await searchWithTwoLengths(page);
		const block = page.locator('.result-detail .stopover');
		const panel = customiser(page);
		const rung = (label: string) => panel.locator('.rung').filter({ hasText: label });

		await pickTimelineSegment(page, 'free-time');
		await expect(panel.getByTestId('stay-mark')).toHaveText('Recommended');
		await expect(block).toContainText(TERMINAL_BED);

		await rung('3 nights').click();

		await expect(panel.getByTestId('bed-swap')).toContainText(
			`3 nights moved the bed from ${TERMINAL_BED} to ${CENTRAL_BED}.`
		);
		await expect(block).toContainText(CENTRAL_BED);
		// Still the app's bed: it moved on its own, so nobody has chosen anything yet.
		await expect(panel.getByTestId('stay-mark')).toHaveText('Recommended');

		// The fused undo and pin: the previous bed comes back AND becomes the traveller's.
		await panel.getByTestId('keep-previous-bed').click();
		await expect(panel.getByTestId('bed-swap')).toHaveCount(0);
		await expect(block).toContainText(TERMINAL_BED);
		await expect(panel.getByTestId('stay-mark')).toHaveText('Your pick');

		// The whole point of the issue: the same two presses that moved the bed a moment ago
		// leave it alone now, and nothing is announced, because the app decided nothing.
		await rung('1 night').click();
		await rung('3 nights').click();
		await expect(panel.getByTestId('bed-swap')).toHaveCount(0);
		await expect(block).toContainText(TERMINAL_BED);
		await expect(panel.getByTestId('stay-mark')).toHaveText('Your pick');

		// And the other position of the same control: hand the bed back to the app.
		await panel.getByTestId('use-recommended-bed').click();
		await expect(block).toContainText(CENTRAL_BED);
		await expect(panel.getByTestId('stay-mark')).toHaveText('Recommended');
	});

	test('an airport buffer the traveller typed survives a change of nights', async ({ page }) => {
		await searchWithTwoLengths(page);
		const panel = customiser(page);

		await pickTimelineSegment(page, 'connection-waiting');
		const buffer = panel.locator('.waiting-stepper-input');
		await buffer.fill('300');
		await buffer.dispatchEvent('input');
		await expect(buffer).toHaveValue('300');

		await pickTimelineSegment(page, 'free-time');
		await panel.locator('.rung').filter({ hasText: '3 nights' }).click();

		await pickTimelineSegment(page, 'connection-waiting');
		await expect(panel.locator('.waiting-stepper-input')).toHaveValue('300');
	});
});
