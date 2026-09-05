import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline, pickStripSegment } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #104: the regression guard for the gap that issue describes. Before it, a real
 * search's itineraries were built, scored, and then reachable only as summary cards.
 * `results-stream-consumption.spec.ts` already proves a real search's providers get
 * called and answer; this proves the rest of the path: expand a real result into its
 * full detail, and confirm a picker choice really changes the total.
 *
 * The Ryanair mock below is deliberately narrower than `mockAllKeylessProviders`' own
 * generic default, which is a STN -> VIE pair built for a different test and never chains
 * an outbound and an onward leg through the same connection airport. This one names the
 * real BCN -> VIE -> TLL flights so the route genuinely connects, with two outbound options
 * (for the flight picker's alternative) and one onward option.
 *
 * Its values come from `support/fixture-markers.ts`: five-figure fares, `ZZ00xx` flight
 * numbers, `FIXTURE`-prefixed place names. The shape is what the parsers are tested
 * against, so it stays realistic; the numbers are worthless on purpose, so a mock that
 * ever escapes this test cannot be written up as a working search. The totals below still
 * assert the real arithmetic, just on figures nobody would book.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('result detail (issue #104)', () => {
	test('expanding a real result shows its timeline and map, and a picker change updates the total', async ({
		page
	}) => {
		await mockAllKeylessProviders(page.context());

		// Registered after mockAllKeylessProviders, so this one wins for every request to
		// this host (Playwright asks the most-recently-registered matching route first).
		// The two outbound options sit on different days: the fare calendar prices one
		// flight per day, so a same-day pair could never both come back.
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

		// ItineraryMap's keyless CARTO basemap (issue #26) — mounted for the first time
		// anywhere in this app by issue #104's ResultDetail. A minimal, sourceless style
		// still fires MapLibre's `load` event, which is all this test needs: it proves the
		// map initialises alongside the timeline and pickers rather than hanging or
		// throwing, without pulling in real vector tiles.
		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await waitForSearchToSettle(page, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();
		await expect(card).toContainText('VIE');

		await openTimeline(page);

		const detail = page.locator('.result-detail');
		await expect(detail).toBeVisible();
		await expect(detail.locator('.itinerary-timeline')).toBeVisible();
		// Issue #280 moved the MapLibre map out of this panel and into a dialog behind the
		// frozen previews, so what mounts alongside the timeline now is the previews row.
		// `route-previews.spec.ts` owns the map itself: that it appears on tap, that there
		// is exactly one of it, and that closing takes it away. This search names no origin
		// or destination location, so the stopover is the only ground leg it has.
		await expect(detail.locator('.ground-legs-item')).toHaveCount(1);

		// Issue #309: the total belongs to the card's own headline and to nothing else. The
		// timeline used to print it again in a totals rail directly under the card's rail,
		// which is the duplication that issue removed, so this reads the surface that owns
		// the figure rather than the copy that no longer exists.
		const totalPriceRow = card.locator('.price-total');
		// 9,111.11 (the 8 March outbound) + 9,333.33 onward. Absurd figures on purpose, see
		// support/fixture-markers.ts, but the sum is still the real arithmetic under test.
		//
		// Both outbounds reach the same 10 March onward flight, so the 8 March one is a
		// two-night stopover and the 9 March one is a single night. Issue #224 made the card
		// open on the shorter trip, and issue #364 corrected that to the cheaper one: the
		// two-night pairing is 111.11 less, and choosing against it was the app spending the
		// traveller's money to shorten a trip they never asked to shorten.
		await expect(totalPriceRow).toContainText('€18,444.44');

		// Switch to the pricier outbound option through the flight picker and confirm the
		// total follows it exactly — brief line 67's "selecting updates ui", proven against
		// a real, wired control rather than FlightPicker's own isolated unit tests.
		// The picker lives inside the timeline row it belongs to and unfolds when that row
		// is selected, so the row is tapped first, the way a traveller reaches it.
		const outboundRow = detail.locator('.itinerary-timeline [data-segment="outbound-flight"]');
		await expect(outboundRow).toContainText('2 flights');
		await outboundRow.click();
		// Issue #278: the picker is in the customise rail beside the list, not folded
		// into the row. The row is still what selects it.
		const outboundPicker = customiser(page).getByRole('radiogroup', { name: /Outbound/ });
		// The 9 March outbound, which is the one the card is NOT on since issue #364 made the
		// cheaper stopover the default.
		const alternativeRow = outboundPicker.locator('.picker-row', { hasText: '€9,222.22' });
		await expect(alternativeRow).toBeVisible();
		// Click the row, which is what a traveller clicks: FlightPicker.svelte styles the
		// whole `<label>` as the control and the `<input>` inside it is `visually-hidden`,
		// so native label semantics do the toggling. Force-clicking the hidden input
		// instead used to work only because the document itself scrolled, which let
		// Playwright bring that zero-area box into the viewport; now that the app shell
		// owns scrolling (issue #119), a forced click on it lands nowhere. Clicking the
		// label is both the fix and the more faithful test.
		await alternativeRow.click();

		await expect(alternativeRow).toContainText('Current pick');
		await expect(totalPriceRow).toContainText('€18,555.55'); // 9,222.22 + 9,333.33
	});

	/**
	 * Issues #224, #225 and #364. The same two-pairing fixture, read from the card instead of
	 * the panel: the cheapest length by default, every other length priced on the card before
	 * anything is pressed, and the number that headline delta is measured against printed
	 * right above it.
	 *
	 * The owner: "the nights should be kept to a minimum by default", "and i can decide to
	 * add more nights if the city is interesting and the hotel in the center". And then, on
	 * the card that made him file #364: "it should pick 1 night if is cheaper". The minimum
	 * he is refusing is nights he PAYS for; a longer stay that costs less is not that.
	 */
	test('the card opens at the cheapest length and prices every other stay', async ({ page }) => {
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

		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await waitForSearchToSettle(page, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		const stripCaption = card.locator('.trip-strip-caption-mid');

		// Issue #278 moved the ladder off the card and into the stopover's own panel, on the
		// reasoning that how long you stay is a property of the stopover and the bed you
		// book is the other one. Everything below is #225's guard unchanged, read from where
		// the control now lives: the card is what it prices, and it is still on screen.
		await pickStripSegment(page, 'stopover');
		const ladder = customiser(page).locator('.staying-longer');
		const rungs = ladder.locator('.rung');

		// Issue #364 turned this case over, and this fixture is where issue #230 wrote down
		// that it was choosing the more expensive trip on purpose: "the fixture's 8 March
		// outbound is two nights and 111.11 cheaper, and the card now opens on the 9 March
		// one anyway." That is the owner's Porto card in miniature, and it opens on the
		// cheaper trip now.
		await expect(stripCaption).toContainText('2 nights');
		await expect(card.locator('.price-headline')).toContainText('Getting there');
		await expect(card.locator('.price-total')).toContainText('€18,444.44');
		await expect(rungs).toHaveText([/1 night/, /2 nights/]);

		// Issue #225: the price of every other length is on the card before anything is
		// pressed, and it is a real pairing's real total rather than a nightly rate. What
		// the ladder buys here is a shorter trip, and it says what that costs.
		await expect(rungs.nth(1)).toHaveAttribute('aria-pressed', 'true');
		await expect(rungs.nth(1)).toContainText('this trip');
		await expect(rungs.nth(0)).toHaveAttribute('aria-pressed', 'false');
		await expect(rungs.nth(0)).toContainText('+€111.11');
		await expect(rungs.nth(0)).toHaveAttribute('aria-label', /1 night in .*\+€111\.11/);
		// The shorter stay is only available on the later outbound, so both flights move.
		await expect(ladder.locator('.ladder-note')).toHaveText('different flights');

		await rungs.nth(0).click();

		await expect(stripCaption).toContainText('1 night');
		await expect(card.locator('.price-total')).toContainText('€18,555.55');
		// The deltas re-anchor on the trip now showing, so the headline plus any rung is
		// still exactly what that rung costs.
		await expect(rungs.nth(0)).toHaveAttribute('aria-pressed', 'true');
		await expect(rungs.nth(1)).toContainText('-€111.11');

		// And back, with no trace left of the detour.
		await rungs.nth(0).click();
		await expect(stripCaption).toContainText('1 night');
		await expect(rungs.nth(0)).toHaveAttribute('aria-pressed', 'true');
		await expect(rungs.nth(1)).toContainText('-€111.11');
	});
});
