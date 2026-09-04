import { test, expect } from './support/fixtures';
import { FIXTURE_NAMES, FIXTURE_PRICES, FIXTURE_FLIGHT_NUMBERS } from './support/fixture-markers';
import { mockAllKeylessProviders, AIRLINE_LOGO_BASE_URL } from './support/providers';

/**
 * Issue #119: `AirlineLogo.svelte` falls back to a styled monogram when the real logo
 * request fails — this is the path an actual user gets whenever `pics.avs.io` is slow,
 * down, or blocked by an extension, not a hypothetical. `fixtures.ts` mocks that host
 * globally with a real stub image for every other spec; this one overrides that mock for
 * Ryanair specifically (Playwright gives the most-recently-registered matching route
 * first refusal, same pattern `select-and-compare.spec.ts` already uses to narrow a
 * shared mock) so the failure path actually fires, and asserts the fallback that reaches
 * the screen — not just that the component has an `onerror` handler.
 *
 * The Ryanair mock below is deliberately narrower than `mockAllKeylessProviders`'s own
 * generic fixture, for the same reason `select-and-compare.spec.ts` already had to do
 * this: `ryanair-mapper.ts` trusts a fare's own embedded departure/arrival codes over
 * whatever the request asked for, and the shared fixture's fare is hardcoded to a
 * STN -> VIE pair, so it can never answer a BCN -> TLL search with anything — the
 * search would still finish (Ryanair "answered", per issue #130), just with zero
 * itineraries, and no card would ever reach the screen for this test to inspect. This
 * mock keys its response on the real query params so a connection genuinely has fares.
 *
 * A direct BCN -> TLL fare is not enough on its own, even keyed correctly: this app's
 * build-time "cheap routes" dataset already lists BCN -> TLL as a served direct route,
 * so the search never asks Ryanair for that exact pair at all — confirmed by logging
 * every request the app made, which fanned out to every candidate hub (BCN -> VIE,
 * VIE -> TLL, BCN -> STN, STN -> TLL, and so on) and never once asked for BCN -> TLL
 * itself, ending in the page's own "well served direct... no stopover here is worth
 * turning into a trip" copy. `select-and-compare.spec.ts` already worked around exactly
 * this by mocking a connection through VIE instead of the direct pair; this test does
 * the same, needing only one leg of it to carry a Ryanair fare to check the logo on.
 */
test.describe('airline logo fallback (issue #119)', () => {
	test('shows a styled monogram, not a broken image, when the logo request fails', async ({ page }) => {
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
					{
						outbound: {
							departureAirport: {
								countryName: FIXTURE_NAMES.country,
								iataCode: 'BCN',
								name: FIXTURE_NAMES.airportA,
								seoName: 'fixture-alpha'
							},
							arrivalAirport: {
								countryName: FIXTURE_NAMES.country,
								iataCode: 'VIE',
								name: FIXTURE_NAMES.airportB,
								seoName: 'fixture-bravo'
							},
							departureDate: '2027-03-08T08:00:00',
							arrivalDate: '2027-03-08T10:15:00',
							price: {
								value: FIXTURE_PRICES.first,
								valueMainUnit: '9111',
								valueFractionalUnit: '11',
								currencySymbol: '€',
								currencyCode: 'EUR'
							},
							flightNumber: FIXTURE_FLIGHT_NUMBERS[2],
							flightKey: `ZZ~${FIXTURE_FLIGHT_NUMBERS[2]}~~BCN~VIE~2027-03-08~2027-03-08~1`,
							previousPrice: null
						}
					}
				];
			} else if (dep === 'VIE' && (arr === 'TLL' || !arr)) {
				fares = [
					{
						outbound: {
							departureAirport: {
								countryName: FIXTURE_NAMES.country,
								iataCode: 'VIE',
								name: FIXTURE_NAMES.airportB,
								seoName: 'fixture-bravo'
							},
							arrivalAirport: {
								countryName: FIXTURE_NAMES.country,
								iataCode: 'TLL',
								name: FIXTURE_NAMES.airportC,
								seoName: 'fixture-charlie'
							},
							departureDate: '2027-03-10T11:00:00',
							arrivalDate: '2027-03-10T13:20:00',
							price: {
								value: FIXTURE_PRICES.third,
								valueMainUnit: '9333',
								valueFractionalUnit: '33',
								currencySymbol: '€',
								currencyCode: 'EUR'
							},
							flightNumber: FIXTURE_FLIGHT_NUMBERS[4],
							flightKey: `ZZ~${FIXTURE_FLIGHT_NUMBERS[4]}~~VIE~TLL~2027-03-10~2027-03-10~1`,
							previousPrice: null
						}
					}
				];
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ fares, size: fares.length, currency: 'EUR' })
			});
		});

		// Registered after mockAllKeylessProviders (and after fixtures.ts's own global
		// airline-logo mock), so this one wins for Ryanair's logo specifically.
		await page.context().route(`${AIRLINE_LOGO_BASE_URL}/**/FR.png`, (route) => route.abort('failed'));

		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();

		// Ryanair operates the one fare this mock hands out, so its chip is the one that
		// should have fallen back.
		const monograms = card.locator('.airline-monogram');
		await expect(monograms.first()).toBeVisible();
		await expect(monograms.first()).toHaveText('RY');
		// Never a broken image left in the DOM alongside the fallback — `AirlineLogo.svelte`
		// swaps to the monogram entirely, it doesn't overlay it on a failed `<img>`.
		await expect(card.locator('img.airline-logo')).toHaveCount(0);
	});
});
