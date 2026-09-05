import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import type { RyanairFlightSpec } from './support/providers';

/**
 * Issue #232: the card says where this trip's fare sits among the fares this browser has
 * already seen, and it says nothing at all until it has seen enough of them.
 *
 * Both halves are the feature. A band drawn from three observations is worse than no band,
 * because a traveller will believe it, so "nothing" has to be the default rather than the
 * fallback. The two tests below are that pair: one route with a month of priced days, one
 * with three, and the only difference between the runs is how many days the fare calendar
 * sells.
 *
 * The prices are five figures and the flight numbers are `ZZ00xx`, from
 * `support/fixture-markers.ts`. They are shaped like Ryanair's answers and worth nothing as
 * ones, for the reason AGENTS.md gives under "Mocks belong to a test and to nothing else".
 */

/** Enough days that `MIN_PRICED_DEPARTURES` (14) is cleared with room to spare, spread far
 * enough in price that the tenth and ninetieth percentiles are not the same number. */
const PRICED_DAYS = 16;

/** `startDay` matters: the search window below opens on 8 March, so a sparse run has to put
 * its handful of days inside it or the page has no itinerary to hang a band on and the test
 * would be measuring an empty results board instead of a withheld band. */
function flightsForMonth(count: number, startDay = 1): RyanairFlightSpec[] {
	const flights: RyanairFlightSpec[] = [];
	for (let index = 0; index < count; index++) {
		const outboundDay = String(index + startDay).padStart(2, '0');
		const onwardDay = String(index + startDay + 2).padStart(2, '0');
		flights.push({
			dep: 'BCN',
			arr: 'VIE',
			depDate: `2027-03-${outboundDay}T08:00:00`,
			arrDate: `2027-03-${outboundDay}T10:15:00`,
			price: 9000 + index * 17.17,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[index % FIXTURE_FLIGHT_NUMBERS.length]
		});
		flights.push({
			dep: 'VIE',
			arr: 'TLL',
			depDate: `2027-03-${onwardDay}T11:00:00`,
			arrDate: `2027-03-${onwardDay}T13:20:00`,
			price: 9500 + index * 23.23,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[(index + 5) % FIXTURE_FLIGHT_NUMBERS.length]
		});
	}
	return flights;
}

const RESULTS_URL = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';

async function search(page: import('@playwright/test').Page, flights: RyanairFlightSpec[]) {
	await mockAllKeylessProviders(page.context());
	// After the generic mock, so this one wins: Playwright offers a request to the
	// most-recently-registered matching route first.
	await routeRyanairFlights(page.context(), flights);
	await page.goto(RESULTS_URL);
	await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
	await expect(page.locator('.result-card').first()).toBeVisible();
}

test.describe('price band (issue #232)', () => {
	test('a month of priced days puts a band on the card, with its sample and its source', async ({ page }) => {
		await search(page, flightsForMonth(PRICED_DAYS));

		const band = page.locator('.result-card').first().locator('.price-band');
		await expect(band).toBeVisible({ timeout: 10_000 });

		// The claim: a rank over a named number of days on a named route. Never an adjective,
		// and never the word "typical", which is a statement about a market this app has
		// never seen.
		await expect(band.locator('.band-note')).toContainText(
			/(Cheaper|Dearer) than (all )?\d+( of the \d+)? days this browser could price BCN to TLL\./
		);
		await expect(band).not.toContainText(/typical/i);

		// The caveat, which is the half that keeps the claim honest. Issue #232 is explicit
		// that the sample size and the source belong on screen rather than in a tooltip, so
		// this is not a wording preference, it is the feature.
		await expect(band.locator('.band-evidence')).toContainText('Prices seen in this browser, not the market.');
		// Which figure is on the track, beside the figure, so nobody reads the range as a band
		// on the headline above it.
		await expect(band.locator('.band-figure')).toContainText('1 adult, flights');

		// The marker is placed, and the track is hidden from assistive tech because every
		// number it encodes is already in the text above and below it.
		await expect(band.locator('.band-marker')).toHaveAttribute('style', /left:/);
		await expect(band.locator('.band-track')).toHaveAttribute('aria-hidden', 'true');
	});

	test('three priced days put no band on the card at all', async ({ page }) => {
		await search(page, flightsForMonth(3, 8));

		// The card is there and priced. What is missing is the comparison, and it is missing
		// on purpose: three observations cannot say what a route usually costs, and a
		// confident-looking bar built on them is the failure this floor exists to prevent.
		await expect(page.locator('.result-card').first().locator('.price-line')).toBeVisible();
		await expect(page.locator('.price-band')).toHaveCount(0);
	});
});
