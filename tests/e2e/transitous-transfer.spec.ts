import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import {
	mockAllKeylessProviders,
	mockHostelworld,
	routeRyanairFlights
} from './support/providers';
import { openTimeline } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #242. Until this file, nothing anywhere asserted a Transitous transfer: not that
 * one renders, not that a card shows a departure time, not that a stopover has ground
 * transport at all. `mockTransitous` existed and was referenced only by the file that
 * defines it and the e2e README.
 *
 * `fixture-mappers.spec.ts` is the other half of closing that hole and catches a fixture
 * the mapper refuses. This one is the half that only a browser can prove: that a timetable
 * Transitous answered with reaches the timeline as a boarding time a traveller reads, past
 * the plausibility filter, the landing buffer and the connection-time check that can each
 * throw the answer away for reasons a mapper test never sees.
 *
 * The setup is `keyless-bed.spec.ts`'s, because `planTransitLegs` only asks about the two
 * stopover legs when a bed is priced — no bed, no question, and a spec that mocked
 * Transitous without one would assert nothing while looking like it did.
 *
 * 10:40am is the fixture's own `2027-03-08T09:40:00Z` read in `Europe/Vienna`, the zone
 * the leg's own `from.tz` names. Not the browser's, not UTC. AGENTS.md: every time the app
 * prints is local to the place it refers to.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('a Transitous timetable reaches the timeline (issue #242)', () => {
	test('a stopover with a bed shows its bus and the time it boards', async ({ page }) => {
		await mockAllKeylessProviders(page.context());

		// Registered after the defaults so it wins: one Hostelworld city at Vienna airport's
		// own coordinates with one property on it, which is what gets a bed priced and
		// therefore what makes `planTransitLegs` ask Transitous anything at all.
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
				flightNumber: FIXTURE_FLIGHT_NUMBERS[5]
			},
			{
				dep: 'VIE',
				arr: 'TLL',
				depDate: '2027-03-10T11:00:00',
				arrDate: '2027-03-10T13:20:00',
				price: FIXTURE_PRICES.third,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[6]
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

		await openTimeline(page);
		const timeline = page.locator('.result-detail .itinerary-timeline');
		await expect(timeline).toBeVisible();

		// Named by segment rather than by position, and both legs of the stopover, because
		// each is its own Transitous question: `planTransitLegs` asks about the ride into
		// town at the moment the flight lands, and about the ride back at the check-in
		// deadline for the onward flight.
		for (const segment of ['transfer-to-hotel', 'transfer-to-connection-airport']) {
			const row = timeline.locator(`.tl-row[data-segment="${segment}"]`);
			// The two things a road answer never produces: the vehicle Transitous named, and
			// the clock time that only `transitSchedule.intended` fills in. Asserting them
			// together is what stops this passing on the driving route the pipeline would
			// otherwise have left in this row.
			await expect(row).toContainText('Bus');
			await expect(
				row.locator('.tl-when-clock'),
				`${segment} should show the boarding time from the Transitous fixture, read in ` +
					"the leg's own Europe/Vienna zone"
			).toHaveText('10:40am');
		}
	});
});
