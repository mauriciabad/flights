import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import type { RyanairFlightSpec } from './support/providers';

/**
 * How tall one result card is on a 375px phone, asserted rather than remembered.
 *
 * Issue #197 brought the card down to 462px and wrote the number in a comment. Issue #232
 * then added a price band, #225 a "staying longer" ladder and #210 a technical-stop note,
 * each of them measured against that comment by whoever happened to read it. By the time
 * issue #278 opened, the card was back over 540px against the roughly 620px a phone has
 * under the header and the tab bar, and nothing in the suite had noticed.
 *
 * So the budget lives here. A card taller than `CARD_HEIGHT_BUDGET_PX` means one screen
 * holds one card, which is the state issue #197 fixed and #278 fixed again: comparing two
 * trips is the whole job of this screen.
 *
 * ## Why 620, and what it costs
 *
 * 620px is what a phone has under the app header and the tab bar, so the ceiling is the
 * screen rather than a number somebody liked. On this fixture the card measures 598px,
 * which leaves 22px: enough to absorb a font metric shifting a line, nowhere near the 54px
 * of the smallest whole block this card has ever gained.
 *
 * It was 520 for about an hour, which is the honest history. #278 took the card from 752px
 * to 492px, and then #287 landed `FlightDetour` on it, an 80px drawing plus its 12px gap.
 * That is a deliberate addition by somebody who measured it, and nothing left on the
 * collapsed card duplicates it: the price receipt, the trip strip and the totals rail each
 * answer a different question, and the detour is the only thing on the card that answers
 * "how far out of the way is this". The `Nights` figure `PickedBed` prints beside the
 * strip's own would have been the thing to spend, and it is not on the collapsed card at
 * all: it is in the timeline, which is unfolded or not there. So the ceiling goes up rather
 * than something else coming off, and the numbers are here so the next reader sees a trade
 * instead of discovering one.
 *
 * The parts, measured at 375px: header 90, price receipt 86, trip strip 79, flight detour
 * 80, totals rail 143, footer 58, plus 60px of gaps and padding.
 *
 * Raising this number again is a decision somebody makes on purpose, in a diff a reviewer
 * sees. The absolute figures are this fixture's, not the owner's: his route line fits one
 * row where BCN to Vienna to Tallinn takes two, and his free-time figure does not wrap.
 */
const CARD_HEIGHT_BUDGET_PX = 620;

/**
 * What the tallest card this app can build measures, which is a different question from the
 * one above and the reason issue #298 was filed.
 *
 * The fixture under `CARD_HEIGHT_BUDGET_PX` is a bare card: two flights, no bed, no ground
 * legs, no price band. It measures 598px and it always will, so that ceiling passed every
 * day while production served cards nobody had measured. On 2026-09-05, at 375x812 against
 * `flights.mauri.app/results/?arr=2026-10-12&dep=2026-10-06&from=BCN&to=PFO`, the six
 * settled cards measured 715, 730, 715, 730, 770 and 730. Every one of them over the
 * ceiling that was green. A limit that cannot see the cards which would fail it is not a
 * limit, and that is the same defect as `45151ce`'s strip rendering at 0px under five green
 * tests, and as #240, #242, #255 and #257.
 *
 * So the second test measures the worst case rather than the average one. `worstCaseSearch`
 * turns on every optional block the collapsed card has, all at once, and this number is
 * what that card measures. The slack over the measured figure is under 22px, which is one
 * receipt row: anything that adds a row fails this test instead of passing on headroom.
 *
 * The parts, measured at 375px: header 98, price receipt 177, price band 140, trip strip
 * 79, flight detour 80, totals rail 143, footer 58, plus 73px of gaps and padding.
 *
 * This number is not a target and it is not the screen. `CARD_HEIGHT_BUDGET_PX` is still
 * what a phone has, and the worst card is 228px over it, so on that card the screen holds
 * one trip and comparing two is impossible. Closing that gap means taking a whole block off
 * the card, and which block is the owner's call rather than a test's: the band is 140px and
 * the newest arrival (#232), the totals rail is 143px, the detour is 80px (#287). This test
 * exists so that gap is a number somebody decided to carry rather than one nobody could
 * see.
 */
const WORST_CASE_HEIGHT_BUDGET_PX = 860;

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('result card size', () => {
	test('one card still fits a phone screen', async ({ page }) => {
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
			{
				dep: 'BCN',
				arr: 'VIE',
				depDate: '2027-03-09T16:30:00',
				arrDate: '2027-03-09T18:45:00',
				price: FIXTURE_PRICES.second,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[3]
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

		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();

		const height = await card.evaluate((element) => element.getBoundingClientRect().height);
		console.log(`result card at 375px: ${Math.round(height)}px`);
		expect(Math.round(height)).toBeLessThanOrEqual(CARD_HEIGHT_BUDGET_PX);
	});

	test('the tallest card this app can build', async ({ page }) => {
		await worstCaseSearch(page);

		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(WORST_CASE_URL);
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 30_000 });
		await expect(page.locator('.result-card').first()).toBeVisible();

		// Every card, not the first one. Which itinerary the pipeline ranks top is not this
		// test's business, and the owner's own report on #298 read the fourth card.
		const heights = await page
			.locator('.result-card')
			.evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().height)));

		// The blocks that make it tall, asserted rather than assumed. Without these the test
		// would go on passing over a fixture that had quietly stopped building the worst case,
		// which is issue #298 happening a second time one level up.
		const tallest = page.locator('.result-card').nth(heights.indexOf(Math.max(...heights)));
		await expect(tallest.locator('.price-band')).toBeVisible();
		await expect(tallest.locator('.flight-shape')).toBeVisible();
		await expect(tallest.locator('.avoid-badge')).toBeVisible();
		// Issue #305 rebuilt this receipt. The bed is a titled group with its nights inside it
		// rather than a `Bed` line, and the ground is one named row per leg rather than up to
		// three rows counting rides by kind, so the guards read the new shape. What they are
		// guarding is unchanged: that this fixture really is building the worst case, and has
		// not quietly stopped, which is #298 happening again one level up.
		await expect(tallest.locator('.price-group .price-part-label').first()).toHaveText('Hotel');
		// A walked leg and a rated one on the same receipt, which is the pair that proves both
		// readings of an absent price are being printed (`domain/transfer.ts`).
		await expect(tallest.locator('.price-part-amount').filter({ hasText: 'free' })).toHaveCount(1);
		const receipt = await tallest.locator('.price-part').evaluateAll((rows) =>
			rows.map((row) => {
				const label = row.querySelector('.price-part-label')?.textContent?.trim();
				const amount = row.querySelector('.price-part-amount')?.textContent?.trim();
				return `${label} -> ${amount}`;
			})
		);
		console.log(`worst-case receipt: ${receipt.join(' | ')}`);
		// Flights, the hotel group's header, at least one nights row and at least two named
		// ground rows: the longest receipt this app can print.
		expect(receipt.length).toBeGreaterThanOrEqual(5);

		console.log(`worst-case result cards at 375px: ${heights.join(', ')}px`);
		expect(Math.max(...heights)).toBeLessThanOrEqual(WORST_CASE_HEIGHT_BUDGET_PX);
	});
});

/**
 * The tallest card the app can build, and why each mock below is here.
 *
 * Issue #298: a ceiling is there to fail on the card that would breach it, so this builds
 * the worst case rather than an average one. Every lever is a real provider answer through
 * the real pipeline. A card assembled by hand would measure whatever its author wanted.
 *
 * - **A month of priced days** puts `PriceBand` on the card (#232), 140px and the single
 *   largest optional block. Sixteen clears `MIN_PRICED_DEPARTURES` with room to spare.
 * - **The Vienna hostel fixture** prices a bed, so the receipt gains a `Bed` row carrying
 *   its nightly rate and its distance from the centre. `people=2` makes that rate read
 *   "for 2", which is what wraps the row onto a second line.
 * - **Transitous answering nothing** is what turns the ground legs into taxis. A bus leg
 *   carries no fare at all and collapses the receipt to one "not priced" row; a taxi leg
 *   carries a rate-card range, and each currency gets a row of its own (#249).
 * - **A London origin against a Tallinn destination** is what makes those two currencies.
 *   The Stansted run rates in GBP off the UK card and the Tallinn run in EUR, which is the
 *   split `priceBreakdown` documents and nothing exercised.
 * - **`avoidAirlines=ZZ`** puts "Airline you avoid" in the header, a badge row of 28px.
 *
 * What is deliberately not here, so the next reader does not take it for an oversight. A
 * technical-stop note reaches the footer only from Kiwi (`kiwi-public-mapper.ts`), and the
 * footer is one ellipsised line, so it costs no height. The `expired-fallback` freshness
 * badge needs a stale IndexedDB entry and a failing refetch, which is a two-load test
 * rather than a fixture. A quoted `Ground` part needs a transfer provider that fills
 * `Transfer.price`, and none does. So this is a floor on the worst case rather than its
 * exact top, and each of those three is one more row the day it lands.
 */
const WORST_CASE_URL =
	'/results/?dep=2027-03-08&arr=2027-03-27&from=STN&to=TLL&people=2&avoidAirlines=ZZ' +
	`&fromLoc=${encodeURIComponent('London Bridge@51.5079,-0.0877')}` +
	`&toLoc=${encodeURIComponent('Tallinn old town@59.4370,24.7536')}`;

/** Enough priced departures to clear `MIN_PRICED_DEPARTURES` (14) with room to spare, and
 * spread far enough in price that the band's tenth and ninetieth percentiles differ. */
const WORST_CASE_PRICED_DAYS = 16;

function worstCaseFlights(): RyanairFlightSpec[] {
	const flights: RyanairFlightSpec[] = [];
	for (let index = 0; index < WORST_CASE_PRICED_DAYS; index++) {
		const outbound = String(index + 1).padStart(2, '0');
		const onward = String(index + 3).padStart(2, '0');
		flights.push({
			dep: 'STN',
			arr: 'VIE',
			depDate: `2027-03-${outbound}T08:00:00`,
			arrDate: `2027-03-${outbound}T10:15:00`,
			price: FIXTURE_PRICES.first + index * 17.17,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[index % FIXTURE_FLIGHT_NUMBERS.length]
		});
		flights.push({
			dep: 'VIE',
			arr: 'TLL',
			depDate: `2027-03-${onward}T11:00:00`,
			arrDate: `2027-03-${onward}T13:20:00`,
			price: FIXTURE_PRICES.second + index * 23.23,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[(index + 5) % FIXTURE_FLIGHT_NUMBERS.length]
		});
	}
	return flights;
}

async function worstCaseSearch(page: Page) {
	await mockAllKeylessProviders(page.context());
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna.json'
	);
	await page
		.context()
		.route('https://api.transitous.org/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: '{"itineraries":[]}' })
		);
	// After the generic mocks, so this one wins: Playwright offers a request to the
	// most-recently-registered matching route first.
	await routeRyanairFlights(page.context(), worstCaseFlights());
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
}
