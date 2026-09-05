import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline } from './support/results-ui';

/**
 * Editing a built itinerary (issue #18's fourth scenario): change the waiting time or the
 * bed, and confirm the whole panel follows rather than part of it.
 *
 * Issues #243 and #250 are one defect seen twice, and both are here. Every reading below is
 * one a person sees at the same moment on the same screen: the stopover block `ResultDetail`
 * puts above the timeline, the two in-city transfer rows inside it, and the totals rail
 * under it. What went wrong both times was those three disagreeing, so the checks are
 * written as agreements between them rather than as one value read in isolation.
 *
 * Two Hostelworld properties, one on the airport and one 32 km north. The search routes to
 * the property it picks and to no other, so picking the second one is the moment the app
 * either says it has no journey or quietly reprints the first one's.
 *
 * Values come from `support/fixture-markers.ts` — €9,222.22 a night, `ZZ00xx` flights,
 * FIXTURE place names — so nothing here could be read as a trip somebody could book.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('editing a stopover keeps one trip on the screen', () => {
	test('a waiting-time edit and a bed swap each move every reading (issues #250, #243)', async ({
		page
	}) => {
		await mockAllKeylessProviders(page.context());
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna-two.json'
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
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		await openTimeline(page);
		const detail = page.locator('.result-detail');
		await expect(detail).toBeVisible();

		const block = detail.locator('.stopover');
		const toBed = detail.locator('[data-segment="transfer-to-hotel"]');
		const fromBed = detail.locator('[data-segment="transfer-to-connection-airport"]');
		const nights = detail.locator('.itinerary-timeline-totals .metric', { hasText: 'Nights' });

		// The property the search routed to, with a journey somebody actually measured: the
		// row and the block quote the same 25 minutes, which is the agreement under test.
		// Both said 55m until issue #290, which is the 25-minute bus with the traveller's own
		// 30-minute walk-out folded in and the sum labelled as the bus. The 55 is still on
		// screen, as the moment of arrival rather than as the length of the ride.
		await expect(block).toContainText('FIXTURE Far Lodge');
		await expect(block).toContainText('25m from the airport');
		await expect(block).toContainText('you arrive 55m after landing');
		await expect(toBed.locator('.tl-duration')).toHaveText('25m');
		await expect(nights).toContainText('2');
		// "Nights 2" since issue #279, where the block's night count became a labelled figure
		// instead of part of a sentence. The agreement under test is unchanged: the rail's
		// count and the block's count are the same number.
		await expect(block).toContainText('Nights 2');

		// Issue #250. 1530 minutes at the connection eats a night off the far end of the
		// stopover. The block used to keep printing the saved trip's window, bed and rate
		// while the rail below it charged for one night fewer.
		const connectionWait = detail.locator('[data-segment="connection-waiting"] input');
		await connectionWait.fill('1530');
		await connectionWait.dispatchEvent('input');

		await expect(nights).toContainText('1');
		await expect(block).toContainText('Nights 1');

		// Issue #243. Reaching the stay list is the two taps a traveller makes: open the
		// stopover row, then pick the other property.
		await detail.locator('[data-segment="free-time"]').click();
		const nearProperty = customiser(page).locator('.alt-card', { hasText: 'FIXTURE Lodge' });
		await expect(nearProperty).toBeVisible();
		await nearProperty.click();

		// The name moved and so did everything that was ever about the other address. The
		// wording matters as much as the absence: no transport provider was ever asked about
		// this property, so nothing on the panel may claim one refused.
		await expect(block).toContainText('FIXTURE Lodge');
		await expect(block).toContainText('Nothing routed to this property');
		await expect(toBed).toContainText('Nothing routed to this property');
		await expect(fromBed).toContainText('Nothing routed back from this property');
		await expect(detail).not.toContainText('no transport provider could route');
		// The other bed's journey is gone from both surfaces, not merely relabelled: neither
		// the 25-minute ride nor the 55 minutes it took to arrive.
		await expect(toBed).not.toContainText('25m');
		await expect(toBed).not.toContainText('55m');
		await expect(block).not.toContainText('25m from the airport');
		await expect(block).not.toContainText('after landing');
	});
});
