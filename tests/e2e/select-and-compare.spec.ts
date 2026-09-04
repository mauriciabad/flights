import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_NAMES, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders } from './support/providers';

/**
 * Issues #103/#104: this is the regression guard for the whole gap those issues
 * describe. Before this pair of issues, `ResultCard.svelte` had no selection mechanism at
 * all and `/comparator/` only ever rendered `?demo=1` fixtures — a real search's
 * itineraries were built, scored and completely unreachable past the results list.
 * `results-stream-consumption.spec.ts` already proves a real search's providers get
 * called and answer; this proves the rest of the path: select two real results, open the
 * comparator, see those exact itineraries (not the demo ones), then drill into one card's
 * full detail and confirm a picker choice really changes the total.
 *
 * The Ryanair mock below is deliberately narrower than `mockAllKeylessProviders`' own
 * generic fixture: `ryanair-mapper.ts` trusts a fare's own embedded departure/arrival
 * codes over whatever the request asked for, so the shared fixture (built for a
 * different, unrelated test) never actually chains an outbound and an onward leg through
 * the same connection airport. This one keys its response on the real query params so
 * BCN -> VIE -> TLL genuinely connects, with two outbound options (for the flight picker's
 * alternative) and one onward option.
 *
 * Its values come from `support/fixture-markers.ts`: five-figure fares, `ZZ00xx` flight
 * numbers, `FIXTURE`-prefixed place names. The shape is what the parsers are tested
 * against, so it stays realistic; the numbers are worthless on purpose, so a mock that
 * ever escapes this test cannot be written up as a working search. The totals below still
 * assert the real arithmetic, just on figures nobody would book.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

interface FareSpec {
	dep: string;
	arr: string;
	depDate: string;
	arrDate: string;
	price: number;
	flightNumber: string;
}

function ryanairFare({ dep, arr, depDate, arrDate, price, flightNumber }: FareSpec) {
	const [whole, frac] = price.toFixed(2).split('.');
	return {
		outbound: {
			departureAirport: {
				countryName: FIXTURE_NAMES.country,
				iataCode: dep,
				name: FIXTURE_NAMES.airportA,
				seoName: 'fixture-alpha'
			},
			arrivalAirport: {
				countryName: FIXTURE_NAMES.country,
				iataCode: arr,
				name: FIXTURE_NAMES.airportB,
				seoName: 'fixture-bravo'
			},
			departureDate: depDate,
			arrivalDate: arrDate,
			price: { value: price, valueMainUnit: whole, valueFractionalUnit: frac, currencySymbol: '€', currencyCode: 'EUR' },
			flightNumber,
			flightKey: `ZZ~${flightNumber}~~${dep}~${arr}~${depDate.slice(0, 10)}~${depDate.slice(0, 10)}~1`,
			previousPrice: null
		}
	};
}

test.describe('select and compare (issues #103/#104)', () => {
	test('selecting real results carries them into the comparator, and a picker change updates the total', async ({
		page
	}) => {
		await mockAllKeylessProviders(page.context());

		// Registered after mockAllKeylessProviders, so this one wins for every request to
		// this host (Playwright asks the most-recently-registered matching route first).
		await page.context().route('https://services-api.ryanair.com/**', async (route) => {
			const url = new URL(route.request().url());
			const dep = url.searchParams.get('departureAirportIataCode');
			const arr = url.searchParams.get('arrivalAirportIataCode');
			let fares: unknown[] = [];
			if (dep === 'BCN' && (arr === 'VIE' || !arr)) {
				fares = [
					ryanairFare({
						dep: 'BCN',
						arr: 'VIE',
						depDate: '2027-03-08T08:00:00',
						arrDate: '2027-03-08T10:15:00',
						price: FIXTURE_PRICES.first,
						flightNumber: FIXTURE_FLIGHT_NUMBERS[2]
					}),
					ryanairFare({
						dep: 'BCN',
						arr: 'VIE',
						depDate: '2027-03-08T16:30:00',
						arrDate: '2027-03-08T18:45:00',
						price: FIXTURE_PRICES.second,
						flightNumber: FIXTURE_FLIGHT_NUMBERS[3]
					})
				];
			} else if (dep === 'VIE' && (arr === 'TLL' || !arr)) {
				fares = [
					ryanairFare({
						dep: 'VIE',
						arr: 'TLL',
						depDate: '2027-03-10T11:00:00',
						arrDate: '2027-03-10T13:20:00',
						price: FIXTURE_PRICES.third,
						flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
					})
				];
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ fares, size: fares.length, currency: 'EUR' })
			});
		});

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

		// Select it: the checkbox issue #103 adds, controlled entirely by the results
		// page's own `selectedIds` state (see ResultCard.svelte's own comment on why it is
		// a plain controlled input, not a locally-owned copy).
		await card.getByRole('checkbox', { name: 'Compare' }).check();
		await expect(page.getByText('1 itinerary selected')).toBeVisible();

		// "Compare" navigates with the real, just-selected itinerary — not the ?demo=1
		// fixtures every earlier comparator test exercised.
		await page.getByRole('button', { name: 'Compare', exact: true }).click();
		await expect(page).toHaveURL(/\/comparator\/$/);
		await expect(page.locator('.comparator-column')).toHaveCount(1);
		await expect(page.locator('.comparator-column').first()).toContainText('VIE');
		await expect(page.locator('.comparator-column').first()).toContainText('BCN');

		// Back to the results list, same search, to reach the per-card detail (issue #104).
		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
		await page.getByRole('button', { name: 'Show details' }).first().click();

		const detail = page.locator('.result-detail');
		await expect(detail).toBeVisible();
		await expect(detail.locator('.itinerary-timeline')).toBeVisible();
		// The map mounts alongside the timeline rather than blocking it (its own async
		// MapLibre setup completes independently) — a labelled "Route map" region is
		// enough to prove it initialised without throwing (ItineraryMap.svelte's
		// `mapAriaLabel` names the cities, not the IATA codes, hence the loose match).
		await expect(detail.getByRole('region', { name: /Route map/ })).toBeVisible();

		const totalPriceRow = detail.locator('.itinerary-timeline-totals .tl-total', { hasText: 'Total price' });
		// 9,111.11 (cheaper outbound) + 9,333.33 onward. Absurd figures on purpose — see
		// support/fixture-markers.ts — but the sum is still the real arithmetic under test.
		await expect(totalPriceRow).toContainText('€18,444.44');

		// Switch to the pricier outbound option through the flight picker and confirm the
		// total follows it exactly — brief line 67's "selecting updates ui", proven against
		// a real, wired control rather than FlightPicker's own isolated unit tests.
		const outboundPicker = detail.getByRole('radiogroup', { name: /Outbound/ });
		const alternativeRow = outboundPicker.locator('.picker-row', { hasText: '€9,222.22' });
		await expect(alternativeRow).toBeVisible();
		// The radio itself is visually-hidden (FlightPicker.svelte styles the whole
		// `<label>` as the clickable row instead), so its own bounding box sits under
		// visible sibling content — `force` skips Playwright's pointer-interception check,
		// which is exactly the check a real click never has to pass here (a genuine click
		// anywhere in the label already toggles the input by native `<label>` semantics).
		await alternativeRow.locator('input[type="radio"]').check({ force: true });

		await expect(alternativeRow).toContainText('Current pick');
		await expect(totalPriceRow).toContainText('€18,555.55'); // 9,222.22 + 9,333.33
	});
});
