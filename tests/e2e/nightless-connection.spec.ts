import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline, pickTimelineSegment } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #426: what does a traveller see between the two flights when no night is booked?
 *
 * Before this branch the answer was a trip to a city. Four rows drew a ride into town,
 * hours of free time there, a ride back and then a wait at the airport those rides had
 * left from and returned to, on a connection that never leaves the terminal. The card
 * printed `2h` of airport wait against a traveller who was airside for twelve, because the
 * other ten were filed under free time, and the totals rail then charged the layover
 * twice.
 *
 * ## The fixture, and why it is shaped this way
 *
 * One outbound and two onward flights, on different days, so one card carries both rungs
 * and the only thing that differs between them is when the second plane leaves. The fare
 * calendar prices at most one flight per route per day, which is why the two onwards are a
 * day apart rather than an hour.
 *
 * ```
 *   OUT       BCN -> VIE   Mon 8   6:30am -> 9am         2h 30m
 *   SAME-DAY  VIE -> TLL   Mon 8   9pm -> 11:30pm        1h 30m
 *   NEXT-DAY  VIE -> TLL   Tue 9   9pm -> 11:30pm        1h 30m
 * ```
 *
 * Both onwards carry the same fare, so the two rungs cost the same money and every
 * difference between them is time. Neither prices a bed. `mockAllKeylessProviders` answers
 * Hostelworld with an empty inventory, which is the state a visitor with no keys is in.
 *
 * Landing at 9am and boarding again at 9pm is twelve hours in the terminal. A day later it
 * is thirty-six hours with a night in Vienna in the middle. The 2h buffer before the
 * outbound is `DEFAULT_WAITING_TIME_RULES`, and nothing routes the traveller to BCN, so
 * door to door is exactly buffer plus outbound plus layover plus onward on both rungs:
 * 120 + 150 + 720 + 90 = 1080 minutes, and 120 + 150 + 2160 + 90 = 2520.
 *
 * ## Why this is a spec
 *
 * This was a probe under `tools/` first, and `guard.spec.ts` was right to refuse it. It
 * aborted every offsite request to keep the page it mounted offline, and an instrument
 * that can answer a request cannot be trusted to detect one. Everything it measured is on
 * the rendered page, so it reads here instead, off the real search pipeline and the real
 * components rather than off two of them mounted in a staging directory.
 */

const OUTBOUND = FIXTURE_FLIGHT_NUMBERS[0];
const ONWARD_SAME_DAY = FIXTURE_FLIGHT_NUMBERS[1];
const ONWARD_NEXT_DAY = FIXTURE_FLIGHT_NUMBERS[2];

/** €9,111.11 + €9,333.33, the two fares and nothing else. Both rungs quote it, which is
 * why they share an onward fare. A night in Vienna changes the trip's shape and its clock,
 * and may not change its price. */
const TRIP_TOTAL = '€18,444.44';

async function searchWithBothOnwards(page: Page) {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), [
		{
			dep: 'BCN',
			arr: 'VIE',
			depDate: '2027-03-08T06:30:00',
			arrDate: '2027-03-08T09:00:00',
			price: FIXTURE_PRICES.first,
			flightNumber: OUTBOUND
		},
		{
			dep: 'VIE',
			arr: 'TLL',
			depDate: '2027-03-08T21:00:00',
			arrDate: '2027-03-08T23:30:00',
			price: FIXTURE_PRICES.third,
			flightNumber: ONWARD_SAME_DAY
		},
		{
			dep: 'VIE',
			arr: 'TLL',
			depDate: '2027-03-09T21:00:00',
			arrDate: '2027-03-09T23:30:00',
			price: FIXTURE_PRICES.third,
			flightNumber: ONWARD_NEXT_DAY
		}
	]);

	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await waitForSearchToSettle(page, { timeout: 20_000 });
	await openTimeline(page);
	await expect(page.getByTestId('segment-customiser')).toBeVisible();

	// Left open for the whole test. Selecting a segment toggles, so opening this a second
	// time would shut the panel rather than reopen it, and `takeOnward` below would then
	// wait out its timeout on a picker that is no longer on screen.
	await pickTimelineSegment(page, 'onward-flight');
	await expect(customiser(page)).toHaveAttribute('data-segment', 'onward-flight');
}

/**
 * Takes one of the two onward flights, by the number printed on its row.
 *
 * The card opens on whichever pairing scores best and both are the same price, so which
 * one that is is not this spec's business. Asking for the flight by name settles it either
 * way, and clicking a row that is already taken fires no change event, which is why the
 * wait afterwards is on "Current pick" rather than on the click.
 */
async function takeOnward(page: Page, flightNumber: string) {
	const row = customiser(page).locator('.picker-row').filter({ hasText: flightNumber });
	await row.click();
	await expect(row.locator('.row-current')).toHaveText('Current pick');
}

function timelineRows(page: Page) {
	return page.locator('[data-testid="segment-customiser"] .itinerary-timeline [data-segment]');
}

function row(page: Page, segment: string) {
	return page.locator(`[data-testid="segment-customiser"] .itinerary-timeline [data-segment="${segment}"]`);
}

function metric(page: Page, label: string) {
	return page
		.locator('.result-card')
		.first()
		.locator('.metric')
		.filter({ hasText: label })
		.locator('.metric-value');
}

test.describe('a connection with no night in it is a wait at the airport', () => {
	test('four rows, and the twelve hours are one of them', async ({ page }) => {
		await searchWithBothOnwards(page);
		await takeOnward(page, ONWARD_SAME_DAY);

		await expect(timelineRows(page)).toHaveCount(4);
		await expect(timelineRows(page).nth(0)).toHaveAttribute('data-segment', 'origin-waiting');
		await expect(timelineRows(page).nth(1)).toHaveAttribute('data-segment', 'outbound-flight');
		await expect(timelineRows(page).nth(2)).toHaveAttribute('data-segment', 'connection-waiting');
		await expect(timelineRows(page).nth(3)).toHaveAttribute('data-segment', 'onward-flight');

		// The three rows this replaces, named one at a time rather than left to the count
		// above, because each of them was a specific claim about a journey the traveller
		// never makes: a ride to a hotel that was never booked, hours in a city they never
		// reach, and a ride back to the airport they never left.
		await expect(row(page, 'transfer-to-hotel')).toHaveCount(0);
		await expect(row(page, 'free-time')).toHaveCount(0);
		await expect(row(page, 'transfer-to-connection-airport')).toHaveCount(0);

		const wait = row(page, 'connection-waiting');
		await expect(wait.locator('.tl-label')).toContainText('Waiting at VIE');
		await expect(wait.locator('.tl-duration')).toHaveText('12h');
	});

	test('the stopover block says where the traveller is, and for how long', async ({ page }) => {
		await searchWithBothOnwards(page);
		await takeOnward(page, ONWARD_SAME_DAY);

		// Issue #440 gave the block to whichever segment IS the stopover, and on this trip that
		// is the wait: there is no free-time row to select, because #426 draws one wait row
		// instead of a ride, a stay and a ride back. Reaching it from the row that describes
		// the same twelve hours is what a traveller does anyway.
		await pickTimelineSegment(page, 'connection-waiting');
		await expect(customiser(page)).toHaveAttribute('data-segment', 'connection-waiting');

		// Issue #228's three-line shape, saying the one thing that is true of this trip. It
		// used to print the two edges of a "free time" window that is a departures hall,
		// under a heading naming a city nobody reaches.
		const block = page.locator('[data-testid="segment-customiser"] .stopover');
		await expect(block.locator('.stopover-edge').first()).toHaveText('Mon 8 from 9am');
		await expect(block.locator('.stopover-days')).toHaveText('Waiting at VIE, 12h');
		await expect(block.locator('.stopover-edge').last()).toHaveText('Mon 8 until 9pm');

		// Not "no bed priced, so the total is a floor", which is the sentence for a stopover
		// that spends a night and could not price one. There is no night here to price.
		await expect(block.locator('.stopover-room')).toHaveText(
			'No night spent here, so there is no bed to price'
		);
		await expect(block).not.toContainText('from the airport');
	});

	test('the layover is counted once, and door to door is the four rows added up', async ({
		page
	}) => {
		await searchWithBothOnwards(page);
		await takeOnward(page, ONWARD_SAME_DAY);

		await expect(row(page, 'origin-waiting').locator('.tl-duration')).toHaveText('2h');
		await expect(row(page, 'outbound-flight').locator('.tl-duration')).toHaveText('2h 30m');
		await expect(row(page, 'connection-waiting').locator('.tl-duration')).toHaveText('12h');
		await expect(row(page, 'onward-flight').locator('.tl-duration')).toHaveText('1h 30m');

		// 2h at BCN plus 12h at VIE. Issue #13's "airport waiting time is not layover time"
		// read from the other end. A layover the traveller cannot leave the airport for is
		// not free time, so the twelve hours are in this figure and in no other, and the
		// cell beside it says so by having nothing to count.
		await expect(metric(page, 'Airport wait')).toHaveText('14h');
		await expect(metric(page, 'Free time')).toHaveText('None');
		await expect(metric(page, 'Door to door')).toHaveText('18h');
	});

	test('a night later the city comes back, and the money does not move', async ({ page }) => {
		await searchWithBothOnwards(page);

		await takeOnward(page, ONWARD_SAME_DAY);
		const total = page.locator('.result-card').first().locator('.price-total');
		await expect(total).toContainText(TRIP_TOTAL);

		await takeOnward(page, ONWARD_NEXT_DAY);

		// The same four rows with the stopover's three put back between them, which is the
		// shape every other spec in this directory measures. Boarding a day later buys a
		// night in Vienna, so there is a hotel to ride to, hours to spend and a ride back.
		await expect(timelineRows(page)).toHaveCount(7);
		await expect(row(page, 'transfer-to-hotel')).toHaveCount(1);
		await expect(row(page, 'free-time')).toHaveCount(1);
		await expect(row(page, 'transfer-to-connection-airport')).toHaveCount(1);

		// 2h buffer, 2h 30m outbound, 36h on the ground and 1h 30m onward. The extra night
		// is worth exactly the 24h between the two onward departures.
		await expect(metric(page, 'Door to door')).toHaveText('1d 18h');
		// `toContainText` because this rung reads "from €18,444.44": a stopover that spends a
		// night with no bed priced quotes a floor, and the nightless one has nothing missing
		// from its total. The figure under both is the same two fares.
		await expect(total).toContainText(TRIP_TOTAL);
	});
});
