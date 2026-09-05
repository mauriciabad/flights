import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #350, in a real browser against a real build.
 *
 * `findConnectionCandidates` sorted, sliced at `DEFAULT_MAX_CANDIDATES` and forgot the rest.
 * The cap is right — each candidate kept costs two metered fare searches downstream, and
 * #255 records what this repo does when it bounds the wrong thing — so nothing here raises
 * it. What was wrong is that the page could say "six stopovers" when the search had
 * confirmed ten, and nothing on screen told the two apart.
 *
 * Both numbers below are measured off this build rather than chosen. Candidate discovery
 * runs on bundled data plus this suite's keyless fixtures, so no provider is called to work
 * them out and the only thing that should move them is that data changing.
 *
 * The two tests are the two halves of the claim, and the second is the one that keeps the
 * first honest. A sentence that is right on the search it was written for and wrong on the
 * next one is worse than no sentence.
 *
 * Which branch each test takes is set by whether it mocks an onward flight, and nothing
 * else. See `search` below for why that is spelled out instead of inferred from the route.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/**
 * Barcelona to somewhere, with Vienna the stopover the fixtures already fly to.
 *
 * `onward` is the whole difference between the two tests, and it decides which branch of
 * `pipeline.ts` runs rather than merely how many cards appear. With an onward flight the
 * primary batch builds an itinerary and #115's fallback sweep never fires. Without one
 * nothing pairs anywhere, the sweep fires, and it re-runs discovery at
 * `FALLBACK_MAX_CANDIDATES`.
 *
 * Stated in the mocks rather than left to a route that happens not to pair. The first
 * version of this spec reached the second branch by accident: `HEL` was missing from
 * `ryanair/active-airports.json`, so `ryanair-mapper.ts` dropped its fares undated (#93's
 * rule) and the search built nothing for a reason the spec never mentioned. #354's guard
 * found that, which is exactly the class of thing it was built for.
 */
/**
 * The candidate universe each test needs, stated rather than inherited.
 *
 * This spec counts stopovers confirmed past the cap, so it needs a known number of them.
 * It used to get one from whatever the bundled sources happened to confirm, which was ten
 * for TLL and eight for HEL. Issue #361 vendored an all-carrier route graph and BCN to TLL
 * now confirms 49, so the counts and the names moved and neither number was ever written
 * down as a choice.
 *
 * `via` is `allowedConnectionAirports`, so these lists ARE the universe. Ten for TLL gives
 * the cap of six something to drop, and eight for HEL is exactly what #115's fallback sweep
 * re-runs at, which is why that test can assert nothing was withheld. Both are stable across
 * a weekly regeneration of the graph in a way that "whatever ranks well today" is not.
 */
const VIA: Record<'TLL' | 'HEL', readonly string[]> = {
	TLL: ['PRG', 'VIE', 'DUS', 'AMS', 'FRA', 'BUD', 'HAM', 'MUC', 'SZG', 'BER'],
	HEL: ['PRG', 'VIE', 'DUS', 'AMS', 'FRA', 'BUD', 'HAM', 'BER']
};

async function search(page: Page, destination: 'TLL' | 'HEL', onward?: { arrival: string }) {
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
		...(onward
			? [
					{
						dep: 'VIE',
						arr: destination,
						depDate: '2027-03-10T11:00:00',
						arrDate: onward.arrival,
						price: FIXTURE_PRICES.third,
						flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
					}
				]
			: [])
	]);
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
	await page.goto(
		`/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=${destination}&via=${VIA[destination].join(',')}`
	);
	await waitForSearchToSettle(page, { timeout: 20_000 });
}

test.describe('stopovers confirmed past the candidate cap (issue #350)', () => {
	test('counts them above the list and names them inside the map', async ({ page }) => {
		await search(page, 'TLL', { arrival: '2027-03-10T13:20:00' });

		// A real card, so this is the page a traveller reads while counting stopovers, not an
		// empty state. It also keeps the #115 fallback sweep out of the way: that sweep only
		// runs when the primary batch built nothing, and the second test below is what it
		// does when it does run.
		await expect(page.locator('.result-card')).toHaveCount(1);

		const trigger = page.locator('.connections-map-link');
		await expect(trigger).toBeEnabled();
		// Both halves, because either one alone is the claim this issue is about: six were
		// considered AND four more exist. The count goes here and the names do not — a list
		// of codes above the results list is the noise that stops the line being read.
		await expect(trigger).toContainText('6 airports considered, including the ones with no trip');
		await expect(trigger).toContainText('4 more confirmed but not priced');

		await trigger.click();
		await expect(page.locator('dialog.connections-dialog')).toBeVisible();

		const lead = page.locator('dialog.connections-dialog .panel-lead');
		await expect(lead).toContainText('6 connection airports considered');
		// Named here, behind the tap. None of these four becomes a card, an arc or a point,
		// so this sentence is the only place in the app they can appear at all.
		await expect(lead).toContainText(
			'4 more airports were confirmed on both flights and not priced: HAM, MUC, SZG and BER.'
		);
	});

	test('says nothing once the fallback sweep has gone back for them', async ({ page }) => {
		// Nothing leaves Vienna for Helsinki here, so the primary batch pairs nothing, issue
		// #115's sweep re-runs discovery at the larger cap, and the two airports the cap of
		// six dropped come back as candidates in their own right. They are on screen now, so
		// "we also found these and did not price them" has stopped being true about them.
		//
		// Without the subtraction in `makeSnapshotFn` this page would list a stopover as
		// withheld in the same breath as drawing it.
		await search(page, 'HEL');

		// The premise, asserted rather than assumed. The sweep only runs on a search that
		// built nothing, so a fixture change that starts pricing this route would move this
		// test onto the other branch and leave it passing for a reason it does not claim —
		// which is how it got here. Nine cards would fail this line; before #354's guard,
		// nothing would have failed at all.
		await expect(page.locator('.result-card')).toHaveCount(0);

		const trigger = page.locator('.connections-map-link');
		// More than `DEFAULT_MAX_CANDIDATES`, which is the sweep's own fingerprint: six is
		// all the primary call can return.
		await expect(trigger).toContainText('8 airports considered');
		await expect(trigger).not.toContainText('confirmed but not priced');

		await trigger.click();
		await expect(page.locator('dialog.connections-dialog')).toBeVisible();
		await expect(page.locator('dialog.connections-dialog .panel-lead')).not.toContainText(
			'not priced'
		);
	});
});
