import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline, pickTimelineSegment } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #387. The owner, on his own acceptance search:
 *
 * > I don't like that only combination is recommended per itinerary... if I want to know
 * > what's the best combination for flying on the 17 for example I can't because it shows
 * > this message and I have to manually figure out the best outgoing flight
 *
 * Nothing in jsdom can check this. The ladder is one component, the pairing search another,
 * and what joins them is a click handler that throws the whole draft away and rebuilds it
 * from a different pairing, three components below the state that decides which.
 *
 * ## The fixture, and why it is shaped this way
 *
 * Two outbounds and two onwards, timed so that `pairConnections` builds three pairings and
 * refuses the fourth:
 *
 * ```
 *   OUT-A  Mon 8   9:45am -> 12:00pm       ONW-1  Tue 9   9:00am
 *   OUT-B  Wed 10  8:00pm -> 10:15pm       ONW-2  Thu 11  4:00pm
 *
 *   (A, ONW-1)  21h layover, 1 night      cheapest, so the card opens here
 *   (A, ONW-2)  3 nights
 *   (B, ONW-2)  17h 45m layover, 1 night
 *   (B, ONW-1)  refused: the onward left the day before B lands
 * ```
 *
 * That last line is the whole issue. Picking OUT-B used to leave ONW-1 where it was and
 * print "The onward flight leaves before this one lands, so there is no connection to make."
 * on a row that also refused to show a price.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

const OUT_A = FIXTURE_FLIGHT_NUMBERS[0];
const OUT_B = FIXTURE_FLIGHT_NUMBERS[1];
const ONW_1 = FIXTURE_FLIGHT_NUMBERS[2];
const ONW_2 = FIXTURE_FLIGHT_NUMBERS[3];

async function searchWithTwoDepartureDates(page: Page) {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), [
		{
			dep: 'BCN',
			arr: 'VIE',
			depDate: '2027-03-08T09:45:00',
			arrDate: '2027-03-08T12:00:00',
			price: FIXTURE_PRICES.first,
			flightNumber: OUT_A
		},
		{
			dep: 'BCN',
			arr: 'VIE',
			depDate: '2027-03-10T20:00:00',
			arrDate: '2027-03-10T22:15:00',
			price: FIXTURE_PRICES.second,
			flightNumber: OUT_B
		},
		{
			dep: 'VIE',
			arr: 'TLL',
			depDate: '2027-03-09T09:00:00',
			arrDate: '2027-03-09T10:20:00',
			price: FIXTURE_PRICES.third,
			flightNumber: ONW_1
		},
		{
			dep: 'VIE',
			arr: 'TLL',
			depDate: '2027-03-11T16:00:00',
			arrDate: '2027-03-11T17:20:00',
			price: FIXTURE_PRICES.third,
			flightNumber: ONW_2
		}
	]);
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);

	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await waitForSearchToSettle(page, { timeout: 20_000 });
	await openTimeline(page);
	await pickTimelineSegment(page, 'outbound-flight');
}

/** One row of the flight picker, by the flight number printed on it. */
function pickerRow(page: Page, flightNumber: string) {
	return customiser(page).locator('.picker-row').filter({ hasText: flightNumber });
}

/** Takes a row. The radio inside it is `visually-hidden` and the label it sits in swallows
 * the pointer, so the label is what a traveller actually presses and what a spec must. */
async function takeRow(page: Page, flightNumber: string) {
	await pickerRow(page, flightNumber).click();
}

test.describe('the departure date has a ladder, and the onward flight follows the outbound', () => {
	test('a rung for every day the stopover can be flown on, priced against the trip shown', async ({
		page
	}) => {
		await searchWithTwoDepartureDates(page);
		const rungs = customiser(page).getByTestId('departure-rung');

		await expect(rungs).toHaveCount(2);
		await expect(rungs.nth(0)).toContainText('Mon 8');
		await expect(rungs.nth(1)).toContainText('Wed 10');

		// The card opens on the cheapest pairing this city can do (#364), which is on the
		// 8th, so that rung is the one marked and the other one carries a real delta.
		await expect(rungs.nth(0)).toHaveAttribute('aria-pressed', 'true');
		await expect(rungs.nth(0)).toContainText('this trip');
		await expect(rungs.nth(1)).toHaveAttribute('aria-pressed', 'false');
		await expect(rungs.nth(1)).toContainText('+€111.11');
	});

	test('pressing a rung returns a real trip on that day, not a warning', async ({ page }) => {
		await searchWithTwoDepartureDates(page);
		const panel = customiser(page);
		const rungs = panel.getByTestId('departure-rung');

		await rungs.nth(1).click();

		await expect(rungs.nth(1)).toHaveAttribute('aria-pressed', 'true');
		// The onward flight moved with it. Left where it was, this pairing would be the
		// sentence the issue is named after.
		await expect(panel).not.toContainText('no connection to make');
		await expect(pickerRow(page, OUT_B)).toContainText('Current pick');

		await pickTimelineSegment(page, 'onward-flight');
		await expect(pickerRow(page, ONW_2)).toContainText('Current pick');
	});

	test('a flight-picker row on another day prices a whole trip and says the onward moves', async ({
		page
	}) => {
		await searchWithTwoDepartureDates(page);
		const row = pickerRow(page, OUT_B);

		await expect(row).not.toContainText('no connection to make');
		await expect(row.locator('.row-price')).toHaveCount(1);
		await expect(row.locator('.row-companion')).toContainText('different onward flight');

		await takeRow(page, OUT_B);

		await pickTimelineSegment(page, 'onward-flight');
		await expect(pickerRow(page, ONW_2)).toContainText('Current pick');
	});

	test('an onward flight the traveller picked is not moved, and the warning says so', async ({
		page
	}) => {
		await searchWithTwoDepartureDates(page);
		const panel = customiser(page);

		// Two presses to pin ONW-1: clicking the row that is already selected fires no
		// change event, so the pin is taken by going away and coming back. Both are real
		// trips through the same city at different lengths.
		await pickTimelineSegment(page, 'onward-flight');
		await takeRow(page, ONW_2);
		await takeRow(page, ONW_1);

		await pickTimelineSegment(page, 'outbound-flight');
		await expect(panel.getByTestId('onward-pin')).toContainText(ONW_1);
		// The one case the sentence is still the right answer to: two flights pinned into an
		// impossible pair on purpose.
		await expect(pickerRow(page, OUT_B)).toContainText('no connection to make');

		await panel.getByTestId('follow-outbound').click();

		await expect(panel.getByTestId('onward-pin')).toHaveCount(0);
		await expect(pickerRow(page, OUT_B)).not.toContainText('no connection to make');
		await expect(pickerRow(page, OUT_B).locator('.row-companion')).toContainText(
			'different onward flight'
		);
	});
});
