import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import type { RyanairFlightSpec } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #434, the owner: "keep track of prices (only when user revisits the page we get a
 * new price entry)".
 *
 * A revisit is a whole page load, so this is the one claim in that issue no unit test can
 * reach. `$lib/saved` proves that `appendObservation` refuses a repeated visit token;
 * nothing below the browser can prove that the results page mints exactly one token per
 * visit, hands that same one to the heart, and then refuses its own recording pass for the
 * visit the trip was saved in. Both halves have to be true or the log gains two rows the
 * first time and none afterwards.
 *
 * The prices are five figures and the flight numbers are `ZZ00xx`, from
 * `support/fixture-markers.ts`, so an escaped fixture is unmistakable (AGENTS.md, "Mocks
 * belong to a test and to nothing else").
 */

const RESULTS_URL = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';
const STORAGE_KEY = 'flights.savedItineraries.v1';

/** Three days of departures, which is fewer than `PriceBand` needs and enough for a card.
 * This test is about the log, not about what else the card draws. */
function flights(): RyanairFlightSpec[] {
	const specs: RyanairFlightSpec[] = [];
	for (let index = 0; index < 3; index++) {
		const outbound = String(index + 8).padStart(2, '0');
		const onward = String(index + 10).padStart(2, '0');
		specs.push({
			dep: 'BCN',
			arr: 'VIE',
			depDate: `2027-03-${outbound}T08:00:00`,
			arrDate: `2027-03-${outbound}T10:15:00`,
			price: 9000 + index * 17.17,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[index % FIXTURE_FLIGHT_NUMBERS.length]
		});
		specs.push({
			dep: 'VIE',
			arr: 'TLL',
			depDate: `2027-03-${onward}T11:00:00`,
			arrDate: `2027-03-${onward}T13:20:00`,
			price: 9500 + index * 23.23,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[(index + 3) % FIXTURE_FLIGHT_NUMBERS.length]
		});
	}
	return specs;
}

interface StoredTrip {
	id: string;
	visits: string[];
}

async function storedTrips(page: Page): Promise<StoredTrip[]> {
	return page.evaluate((key) => {
		const raw = localStorage.getItem(key);
		if (!raw) return [];
		return (JSON.parse(raw) as { id: string; prices: { visit: string }[] }[]).map((entry) => ({
			id: entry.id,
			visits: entry.prices.map((price) => price.visit)
		}));
	}, STORAGE_KEY);
}

async function openResults(page: Page) {
	await page.goto(RESULTS_URL);
	await waitForSearchToSettle(page, { timeout: 20_000 });
}

test.describe('the heart on a result card', () => {
	test.beforeEach(async ({ page }) => {
		await mockAllKeylessProviders(page.context());
		// After the generic mock, so this one wins: Playwright offers a request to the
		// most-recently-registered matching route first.
		await routeRyanairFlights(page.context(), flights());
	});

	test('one visit appends exactly one price, and the visit it was saved in appends none of its own', async ({
		page
	}) => {
		await openResults(page);
		expect(await storedTrips(page)).toEqual([]);

		const heart = page.locator('.result-card .save-trip').first();
		await expect(heart).toHaveAttribute('aria-label', /^Save /);
		await heart.click();

		// The heart seeds the log with the price on screen when it was pressed, and the
		// page's own recording pass for that same visit has to be a refusal rather than a
		// second row. That is what makes the count below 1 and not 2.
		await expect(heart).toHaveAttribute('aria-label', /^Remove .* from saved trips$/);
		const saved = await storedTrips(page);
		expect(saved).toHaveLength(1);
		expect(saved[0].visits).toHaveLength(1);

		await openResults(page);
		const afterOneReturn = await storedTrips(page);
		expect(afterOneReturn[0].visits).toHaveLength(2);

		await openResults(page);
		const afterTwoReturns = await storedTrips(page);
		expect(afterTwoReturns[0].visits).toHaveLength(3);
		expect(
			new Set(afterTwoReturns[0].visits).size,
			`two rows share a visit token: ${afterTwoReturns[0].visits.join(', ')}`
		).toBe(3);
	});

	test('a saved card says where today sits against the price it was saved at, and an unsaved one says nothing', async ({
		page
	}) => {
		await openResults(page);
		const card = page.locator('.result-card').first();
		await expect(card.locator('.price-note')).toHaveCount(0);

		await card.locator('.save-trip').click();
		// Still one price, so still nothing to compare it against.
		await expect(card.locator('.price-note')).toHaveCount(0);

		await openResults(page);
		await expect(page.locator('.result-card').first().locator('.price-note')).toHaveText(
			'No change'
		);
	});

	test('forgetting a trip takes it off the list, and pressing again puts the same record back', async ({
		page
	}) => {
		await openResults(page);
		const heart = page.locator('.result-card .save-trip').first();
		await heart.click();
		await openResults(page);

		const twoVisits = await storedTrips(page);
		expect(twoVisits[0].visits).toHaveLength(2);

		// A heart is a toggle, so a mis-tap has to be free. It is not free by default: a
		// removal throws away the log, and a fresh save would come back with one row.
		const second = page.locator('.result-card .save-trip').first();
		await second.click();
		expect(await storedTrips(page)).toEqual([]);
		await expect(second).toHaveAttribute('aria-label', /^Save /);

		await second.click();
		const restored = await storedTrips(page);
		expect(restored).toHaveLength(1);
		expect(restored[0].visits).toEqual(twoVisits[0].visits);
	});
});
