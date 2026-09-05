import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Whether the results page holds still while it fills. Issue #314.
 *
 * Production measured 1.42 of Cumulative Layout Shift on a 375px phone and 0.60 on a
 * desktop, against Google's 0.10 for "good" and 0.25 for "poor", with the last shift landing
 * twenty-five seconds after navigation. Three things were moving, and this file has a test
 * per thing so a regression says which one came back rather than only that a number went up:
 *
 * 1. Nothing reserved the space the results would need, so the provider strip and the widen
 *    panel below the list sat in the middle of an empty screen and were pushed down the page
 *    once per arrival.
 * 2. A result that sorted better than one already on screen took its place and shoved it out
 *    of view. Reserving space cannot help with that: the space was reserved and the card
 *    still moved, because what moved it was inserted above it. It goes to the end of the
 *    list now, and the page offers to sort it in.
 * 3. Two rows above the list, the count and the "flexible dates" link, each grew a line
 *    partway through the search and moved every card on screen to do it.
 *
 * The mocks answer each stopover a second apart, because a search that resolves in one frame
 * cannot shift and would pass this file no matter what the page did. `tools/probe-cls.mjs`
 * is the other half of the pair: same measurement, real providers, real timing, for a number
 * to put in an issue.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** Google's bar for "good", which is what issue #314 asks this page to reach. */
const GOOD_CLS = 0.1;

/** Matches `RESERVED_RESULT_SLOTS` in `src/routes/results/+page.svelte`. */
const RESERVED_SLOTS = 2;

const SEARCH_URL = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';

/**
 * Vienna is answered first and is the more expensive trip; Charleroi answers a second later
 * and is cheaper, so it scores better and would have taken Vienna's place at the top. That is
 * the arrival order issue #314 measured three times in one production run.
 *
 * It was Bergamo until issue #340. Ranking a stopover on how evenly it splits the journey
 * drops Bergamo out of Barcelona to Tallinn's candidates: northern Italy is a corner cut off
 * a journey that ends in the Baltic, and a fare fixture cannot put back a city the connection
 * graph no longer proposes. Nothing about what this file tests changes — a cheaper trip still
 * arrives second and still has to land at the end — only which city stands in.
 *
 * The six candidates are now Vienna, Budapest, Berlin, Charleroi, Kraków and Stansted, read
 * off the connections panel rather than guessed. Four of the five price cleanly with this
 * fixture and Berlin does not: it is proposed, and then refused with "nothing flies here"
 * even though the mock answers `BCN/BER/cheapestPerDay` exactly as it answers the other four.
 * I did not chase it down. It is in fare fetching rather than in candidate selection, which
 * is the half issue #340 changed, so it is somebody's else's bug or nobody's — but do not
 * reach for BER here expecting it to work.
 */
const CONNECTION_DELAY_MS: Record<string, number> = { VIE: 0, CRL: 1200 };

function flights() {
	const specs = [];
	for (const [connection, premium] of [
		['VIE', 120],
		['CRL', 0]
	] as const) {
		specs.push({
			dep: 'BCN',
			arr: connection,
			depDate: '2027-03-08T08:00:00',
			arrDate: '2027-03-08T10:15:00',
			price: FIXTURE_PRICES.first + premium,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[0]
		});
		specs.push({
			dep: connection,
			arr: 'TLL',
			depDate: '2027-03-11T11:00:00',
			arrDate: '2027-03-11T13:20:00',
			price: FIXTURE_PRICES.second + premium,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[1]
		});
	}
	return specs;
}

/**
 * Registered after `routeRyanairFlights`, so Playwright offers it the request first: it
 * sleeps for the stopover named in the path and then hands the request on to the mock that
 * actually answers it.
 */
async function answerStopoversInTurn(page: Page) {
	await page.context().route('https://services-api.ryanair.com/**', async (route) => {
		const codes = new URL(route.request().url()).pathname.match(/\/([A-Z]{3})\/([A-Z]{3})(?:\/|$)/);
		const delay = codes
			? Math.max(CONNECTION_DELAY_MS[codes[1]] ?? 0, CONNECTION_DELAY_MS[codes[2]] ?? 0)
			: 0;
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		await route.fallback();
	});
}

async function openStreamingSearch(page: Page) {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), flights());
	await answerStopoversInTurn(page);
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
}

/** The issue's own instrument, installed before the app's script so `buffered: true` has the
 * whole navigation to replay. */
async function watchLayoutShift(page: Page) {
	await page.addInitScript(() => {
		let total = 0;
		const moved: string[] = [];
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as (PerformanceEntry & {
				value: number;
				hadRecentInput: boolean;
				sources?: { node?: Node | null }[];
			})[]) {
				if (entry.hadRecentInput) continue;
				total += entry.value;
				for (const source of entry.sources ?? []) {
					const node = source.node;
					if (node instanceof Element) {
						moved.push(`${entry.value.toFixed(4)} ${node.tagName.toLowerCase()}.${node.className}`);
					}
				}
			}
		}).observe({ type: 'layout-shift', buffered: true });
		Object.defineProperty(window, '__layoutShift', { get: () => ({ total, moved }) });
	});
}

async function readLayoutShift(page: Page) {
	return page.evaluate(
		() => (window as unknown as { __layoutShift: { total: number; moved: string[] } }).__layoutShift
	);
}

test.describe('the results page holds still while it fills', () => {
	test('reserves card-shaped slots before a single result has arrived', async ({ page }) => {
		await openStreamingSearch(page);
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(SEARCH_URL);

		const slots = page.locator('.results-list > li');
		await expect(slots).toHaveCount(RESERVED_SLOTS);
		// Before any card exists. If a result beat the assertion here the test would be
		// measuring the filled list instead of the reservation.
		await expect(page.locator('.result-card')).toHaveCount(0);

		const heights = await slots.evaluateAll((items) =>
			items.map((item) => Math.round(item.getBoundingClientRect().height))
		);
		// The number that makes the reservation work: at or above the height of the list's
		// visible band, the second slot starts off screen and stays there whatever height the
		// card that fills the first one turns out to be.
		expect(Math.min(...heights), `slot heights ${heights.join(', ')}`).toBeGreaterThanOrEqual(480);

		// Everything that explains the results rather than being one starts below the fold,
		// which is why its 594px of growth costs nothing. This is the assertion for cause 1.
		const contextTop = await page
			.locator('.results-context')
			.evaluate((section) => section.getBoundingClientRect().top);
		expect(Math.round(contextTop)).toBeGreaterThan(812);
	});

	test('a better trip arriving late lands at the end, not on top of what is on screen', async ({
		page
	}) => {
		await openStreamingSearch(page);
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(SEARCH_URL);

		const firstCard = page.locator('.result-card').first();
		await expect(firstCard).toBeVisible({ timeout: 20_000 });
		// The stopover, not the whole card: a card carries badges that come and go on their
		// own ("Still confirming...") and this test is about which trip is on top.
		const stopover = firstCard.locator('.route-leg-stopover');
		await expect(stopover).toContainText('Vienna');
		const before = (await firstCard.boundingBox())!;

		// Charleroi is cheaper, so it sorts above Vienna, and Vienna is the card filling the
		// screen. It arrives anyway, at the end.
		await expect(page.locator('.result-card')).toHaveCount(2, { timeout: 20_000 });
		await expect(page.locator('.result-card').nth(1).locator('.route-leg-stopover')).toContainText(
			'Charleroi'
		);

		// The whole point: the card the traveller is reading has not moved, and it is still
		// the same trip.
		const after = (await firstCard.boundingBox())!;
		expect(Math.round(after.y)).toBe(Math.round(before.y));
		await expect(stopover).toContainText('Vienna');

		// What waited is the reordering, and the page says so and offers to do it.
		const control = page.getByRole('button', { name: /sort \d+ trip/i });
		await expect(control).toBeVisible();
		await control.click();
		await expect(control).toHaveCount(0);
		await expect(page.locator('.result-card').first().locator('.route-leg-stopover')).toContainText(
			'Charleroi'
		);
	});

	for (const [name, width, height] of [
		['a phone', 375, 812],
		['a desktop', 1280, 900]
	] as const) {
		test(`streams a whole search on ${name} inside Google's "good" bar`, async ({ page }) => {
			await watchLayoutShift(page);
			await openStreamingSearch(page);
			await page.setViewportSize({ width, height });
			await page.goto(SEARCH_URL);

			await waitForSearchToSettle(page, { timeout: 30_000 });
			await expect(page.locator('.result-card').first()).toBeVisible();
			// The page goes on moving after the last card lands: a background revalidation
			// (#293) re-renders cards in place, and issue #314's largest production shift
			// arrived 25 seconds in. Measuring at the moment the search settles would miss it.
			await page.waitForTimeout(5_000);

			const { total, moved } = await readLayoutShift(page);
			expect(total, `${total.toFixed(4)} from: ${moved.join(' | ')}`).toBeLessThanOrEqual(GOOD_CLS);
		});
	}
});
