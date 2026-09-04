import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';

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
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();
		await expect(card).toContainText('VIE');

		await page.getByRole('button', { name: 'Show details' }).first().click();

		const detail = page.locator('.result-detail');
		await expect(detail).toBeVisible();
		await expect(detail.locator('.itinerary-timeline')).toBeVisible();
		// The map mounts alongside the timeline rather than blocking it (its own async
		// MapLibre setup completes independently) — a labelled "Route map" region is
		// enough to prove it initialised without throwing (ItineraryMap.svelte's
		// `mapAriaLabel` names the cities, not the IATA codes, hence the loose match).
		await expect(detail.getByRole('region', { name: /Route map/ })).toBeVisible();

		const totalPriceRow = detail.locator('.itinerary-timeline-totals .metric', { hasText: 'Total price' });
		// 9,111.11 (cheaper outbound) + 9,333.33 onward. Absurd figures on purpose — see
		// support/fixture-markers.ts — but the sum is still the real arithmetic under test.
		await expect(totalPriceRow).toContainText('€18,444.44');

		// Switch to the pricier outbound option through the flight picker and confirm the
		// total follows it exactly — brief line 67's "selecting updates ui", proven against
		// a real, wired control rather than FlightPicker's own isolated unit tests.
		const outboundPicker = detail.getByRole('radiogroup', { name: /Outbound/ });
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
});
