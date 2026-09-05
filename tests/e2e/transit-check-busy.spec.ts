import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline, pickTimelineSegment } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #385: what "Check public transport" looks like between the press and the answer.
 *
 * The press is the one gesture in this app that spends a provider request, and pressing it
 * used to make it disappear. `checkTransitForPickedProperty` writes `{ kind: 'checking' }`
 * synchronously, `canCheckTransit` gated on that entry being absent, so the button unmounted
 * before the finger left it while the notice above went on saying "Public transport was not
 * looked up for this property" for both Transitous round trips.
 *
 * Every other spec that touches this press asserts what is on screen once the answer lands,
 * which is exactly the window this defect lived outside of. So this one holds the two
 * `/plan` responses open and reads the page while they are in flight.
 */

const BCN_VIE_TLL = [
	{
		dep: 'BCN',
		arr: 'VIE',
		depDate: '2027-03-08T08:00:00',
		arrDate: '2027-03-08T10:15:00',
		price: FIXTURE_PRICES.first,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[7]
	},
	{
		dep: 'VIE',
		arr: 'TLL',
		depDate: '2027-03-10T11:00:00',
		arrDate: '2027-03-10T13:20:00',
		price: FIXTURE_PRICES.third,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[8]
	}
];

test('the press stays on screen and says it is running until the answer lands', async ({ page }) => {
	await mockAllKeylessProviders(page.context());
	// The press is offered only for a bed the search never routed to, so the search has to
	// find two. Registered after the blanket mock, which answers Hostelworld with an empty
	// city: Playwright matches handlers in reverse registration order.
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna-both-far.json'
	);
	await routeRyanairFlights(page.context(), BCN_VIE_TLL);

	// The press's own two `/plan` calls, held open on purpose. Mocked, they answer in under a
	// frame and the state this test is about would never be on screen long enough to read.
	//
	// Armed at the press rather than at registration, because the search makes its own
	// Transitous calls for the bed it picks and holding those just stops the search. The
	// first run of this test timed out at `data-search-phase="searching"` for that reason.
	let holdingForThePress = false;
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.context().route('https://api.transitous.org/**', async (route) => {
		if (holdingForThePress) await held;
		await route.fallback();
	});

	const params = new URLSearchParams({
		dep: '2027-03-08',
		arr: '2027-03-27',
		from: 'BCN',
		to: 'TLL',
		fromLoc: 'FIXTURE start point@41.3851,2.1734',
		toLoc: 'FIXTURE end point@59.4370,24.7536'
	});
	await page.goto(`/results/?${params}`);
	await waitForSearchToSettle(page, { timeout: 20_000 });
	await openTimeline(page);

	await pickTimelineSegment(page, 'free-time');
	const otherBed = customiser(page).locator('.alt-card', { hasText: 'FIXTURE Far Lodge' });
	await expect(otherBed).toBeVisible();
	await otherBed.click();
	await expect(page.locator('.result-detail').locator('.stopover')).toContainText('FIXTURE Far Lodge');

	await pickTimelineSegment(page, 'transfer-to-hotel');
	const notice = customiser(page).getByTestId('transit-notice');
	await expect(notice).toHaveAttribute('data-transit-answer', 'not-asked');
	await expect(notice).toContainText('Public transport was not looked up for this property');

	const check = customiser(page).getByRole('button', { name: 'Check public transport' });
	await expect(check).toBeEnabled();
	holdingForThePress = true;
	await check.click();

	// The whole of issue #385, in four assertions. The control the traveller pressed is still
	// where they pressed it, it reads as busy rather than as pressable, and the sentence above
	// it has stopped saying nobody asked while the asking is under way.
	await expect(check).toBeVisible();
	await expect(check).toBeDisabled();
	await expect(notice).toHaveAttribute('data-transit-answer', 'checking');
	await expect(notice).toContainText('Checking public transport for this property');
	// A live region, so a traveller who cannot see the spinner is told as well.
	await expect(notice).toHaveAttribute('role', 'status');

	release();

	// And the end state is unchanged. The offer is spent once the answer exists, and what the
	// traveller pressed for is a row offering the bus.
	await expect(customiser(page).locator('.picker-row', { hasText: 'Public transport' })).toBeVisible({
		timeout: 20_000
	});
	await expect(check).toHaveCount(0);
	await expect(notice).toHaveCount(0);
});
