import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import {
	mockAllKeylessProviders,
	mockHostelworld,
	mockTransitousPerLegMoment,
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
 *
 * Issue #368 gave the two legs two timetables. One canned answer for both was already
 * wrong, and only invisibly so: the ride back to the airport is planned backwards from a
 * Wednesday check-in deadline and this row was printing a Sunday-morning departure at it,
 * which is exactly the "a schedule with no stated moment is a coincidence" that #135 exists
 * to prevent. Now that the closing edge of the stopover reads that departure, a bus leaving
 * two days before the traveller lands is refused by the connection-time check and the row
 * keeps its walk, which is what this spec caught.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** The one search both tests below read, up to the point the detail panel is open. */
async function stopoverWithTransitBothWays(page: Page): Promise<void> {
	await mockAllKeylessProviders(page.context());
	// After the defaults so it wins, and per leg so each timetable belongs to the moment
	// its own lookup was planned for.
	await mockTransitousPerLegMoment(page.context());

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

	await page
		.context()
		.route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await waitForSearchToSettle(page, { timeout: 20_000 });

	const card = page.locator('.result-card').first();
	await expect(card).toBeVisible();
	await expect(card).toContainText('VIE');

	await openTimeline(page);
}

test.describe('a Transitous timetable reaches the timeline (issue #242)', () => {
	test('a stopover with a bed shows its bus and the time it boards', async ({ page }) => {
		await stopoverWithTransitBothWays(page);
		const timeline = page.locator('.result-detail .itinerary-timeline');
		await expect(timeline).toBeVisible();

		// Named by segment rather than by position, and both legs of the stopover, because
		// each is its own Transitous question: `planTransitLegs` asks about the ride into
		// town at the moment the flight lands, and about the ride back at the check-in
		// deadline for the onward flight.
		// 10:40am is `plan.json`'s 09:40Z, the ride out of the airport. 8:10am is
		// `plan-arriveby.json`'s 07:10Z on the 10th, the last bus that still makes the 9am
		// check-in deadline for an 11am flight.
		const boards: Record<string, string> = {
			'transfer-to-hotel': '10:40am',
			'transfer-to-connection-airport': '8:10am'
		};
		for (const [segment, clock] of Object.entries(boards)) {
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
			).toHaveText(clock);
		}

		// Issue #368: the stopover block's closing edge and the row's clock are one event.
		// Before the split they were the deadline minus the ride and the real last bus,
		// 25 minutes apart here and 1h 28m apart on the owner's own production card.
		await expect(page.locator('.result-detail .stopover .stopover-edge').last()).toContainText(
			'until 8:10am'
		);
	});

	test('the leg Transitous drew a shape for is a solid route, and the one it did not is still dashed', async ({
		page
	}) => {
		// Issue #416. Both fixtures answer the same host with the same kind of timetable, and
		// only `plan.json` carries a `legGeometry`. That asymmetry is deliberate and it is the
		// whole test: the stopover preview owns both in-city legs, so one picture holds the
		// two states side by side, and neither can pass by accident.
		await stopoverWithTransitBothWays(page);

		const stopover = page.locator('.result-detail .ground-legs-item').filter({ hasText: 'The stopover' });
		await expect(stopover).toHaveCount(1);

		const legs = stopover.locator('svg path.rp-leg');
		await expect(legs).toHaveCount(2);

		// `.is-estimate` is the class `RoutePreview` hangs the dash on, so counting it is
		// counting the dashes a traveller sees. Counted rather than located, because a
		// Playwright `filter` matches descendants and these are leaf `<path>`s.
		const drawn = await legs.evaluateAll((paths) =>
			paths.map((path) => ({
				dashed: path.classList.contains('is-estimate'),
				// A two-point hop's `d` has exactly one `L` in it. A route has one per bend.
				segments: (path.getAttribute('d') ?? '').split('L').length - 1
			}))
		);
		const dashed = drawn.filter((leg) => leg.dashed);
		const routed = drawn.filter((leg) => !leg.dashed);

		expect(dashed, 'the arriveBy leg carries no legGeometry, so it must stay a dash').toHaveLength(1);
		expect(dashed[0].segments, 'a schematic hop is one straight line').toBe(1);
		expect(routed, 'the ride into town has geometry, so it must draw as a real route').toHaveLength(1);
		expect(routed[0].segments, 'a real route bends').toBeGreaterThan(5);

		// The same thing in words, once, for the leg that is still a guess. `segments.ts`
		// writes that caveat and it is the screen-reader half of the dash.
		const name = (await stopover.locator('.ground-leg').textContent()) ?? '';
		expect(name.match(/straight-line estimate/g) ?? []).toHaveLength(1);
	});
});
