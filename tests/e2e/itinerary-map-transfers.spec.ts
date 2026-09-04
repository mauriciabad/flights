import { test, expect } from './support/fixtures';
import { routeRyanairFlights } from './support/providers';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_NAMES, FIXTURE_PRICES } from './support/fixture-markers';
import { mockHostelworld, mockKiwiPublic } from './support/providers';

/**
 * Issue #118: the owner's own complaint, verified against a real search end to end
 * rather than a hand-built fixture — "the map is wrong! i dont want just a map of the
 * flights i want also the transport from starting point to airport, in the conection
 * travel to and from hotel and to destination point, with markers for start hotel and
 * end". It needs a three-airport journey with an origin and a destination location on
 * top, so that all four transfer legs exist to check rather than only the two
 * connection-side ones.
 *
 * KEF -> OSL -> TBS, not the owner's BVC -> LGW -> PFO. This spec used to run on his
 * reference route, at his dates, with two legs priced 149 and 89 to make his EUR 238 —
 * and then an agent copied these mocks into the shared Playwright MCP browser to look at
 * the map, left them armed, and a second agent measuring an unrelated page read them back
 * as "1 itinerary, BVC -> LGW -> PFO, EUR 238.00, via Ryanair, with zero keys configured"
 * and reported the app working. Ryanair does not serve BVC. A fixture built to look like
 * the goal cannot be told apart from reaching the goal, so this one is built to look like
 * nothing at all: figures from `support/fixture-markers.ts`, and three airports in three
 * different timezones (UTC+0, UTC+1, UTC+4) so the overnight-connection arithmetic still
 * gets the workout the Cape Verde -> London -> Cyprus route was chosen for.
 *
 * Ryanair stands in for Skyscanner here (keyless, no RapidAPI key needed) purely as a
 * source of matching flight offers for this fictional pairing — the same substitution
 * `result-detail.spec.ts` already makes for its own route. Booking.com gets a fake
 * key through the settings UI so a stay actually prices, which is what makes
 * `transferToHotel`/`transferToConnectionAirport` exist at all (issue #94's "all three
 * together or none").
 *
 * One OSRM leg (origin location -> KEF) is deliberately mocked WITHOUT a `geometry`
 * field, so this test proves both branches of the honest-geometry decision in one real
 * pipeline run: the three legs OSRM answers with a shape render as real routes (no
 * "(straight-line estimate)" caveat), and the one leg it doesn't render as the honest
 * schematic fallback instead.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

// Real-ish, but fixed, coordinates so this test controls exactly which OSRM request
// answers which leg rather than depending on the live demo server's actual road network.
// The IATA codes are the one thing that has to stay real: the app resolves each one
// against its own OurAirports dataset for coordinates, city and timezone, so a synthetic
// code returns no itinerary and this test would stop exercising the pipeline.
const KEF_APT = { lat: 63.985, lon: -22.6056 }; // Keflavík International
const KEF_LOC = { lat: 64.0049, lon: -22.5646 }; // A point inland, ~3 km away
const OSL_APT = { lat: 60.1939, lon: 11.1004 }; // Oslo Gardermoen
const OSL_HOTEL = { lat: 60.1712, lon: 11.0669 }; // A stand-in for the connection hotel
const TBS_APT = { lat: 41.6692, lon: 44.9547 }; // Tbilisi International
const TBS_LOC = { lat: 41.6935, lon: 44.9021 }; // A point in town, ~5 km away

function roughlyMatches(a: number, b: number): boolean {
	return Math.abs(a - b) < 0.01;
}

/** `true` when the two endpoints an OSRM `/route/` request names are (in either order)
 *  the origin-location <-> KEF-airport pair — the one leg this test deliberately answers
 *  with no route shape, to prove the schematic fallback still works inside a real
 *  pipeline run. */
function isOriginAirportLeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean {
	const matches = (p: { lat: number; lon: number }, q: { lat: number; lon: number }) =>
		roughlyMatches(p.lat, q.lat) && roughlyMatches(p.lon, q.lon);
	return (matches(a, KEF_LOC) && matches(b, KEF_APT)) || (matches(a, KEF_APT) && matches(b, KEF_LOC));
}

test.describe('itinerary map: every transfer leg, distinct markers, honest geometry (issue #118)', () => {
	test('a real search draws all four transfers, marks start/hotel/end distinctly from airports, and only labels the leg with no OSRM shape as an estimate', async ({
		page
	}) => {
		// -----------------------------------------------------------------
		// 1. A fake Booking.com key, through the real settings UI — Booking's own
		//    healthCheck reuses searchHotelsByCoordinates (booking.ts), so the same
		//    handler registered below answers both the Save-triggered test and the real
		//    search later.
		// -----------------------------------------------------------------
		const bookingSearches: string[] = [];
		await page.context().route('https://booking-com15.p.rapidapi.com/**', async (route) => {
			const url = route.request().url();
			if (url.includes('getRoomList')) {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						data: {
							block: [
								{
									room_name: `${FIXTURE_NAMES.property} private double`,
									is_dormitory: 0,
									product_price_breakdown: {
										gross_amount_per_night: { value: FIXTURE_PRICES.perNight, currency: 'EUR' }
									}
								}
							]
						}
					})
				});
				return;
			}
			bookingSearches.push(url);
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					data: {
						result: [
							{
								hotel_id: 918273,
								hotel_name: FIXTURE_NAMES.property,
								latitude: OSL_HOTEL.lat,
								longitude: OSL_HOTEL.lon,
								composite_price_breakdown: {
									gross_amount_per_night: { value: FIXTURE_PRICES.perNight, currency: 'EUR' }
								}
							}
						]
					}
				})
			});
		});

		await page.goto('/settings/');
		const bookingCard = page.locator('.provider-card', { hasText: 'Booking.com' });
		await bookingCard.getByLabel('RapidAPI key').fill('sk-e2e-test-key-118');
		await bookingCard.getByRole('button', { name: 'Save' }).click();
		await expect(bookingCard.getByText('••••-118')).toBeVisible();

		// -----------------------------------------------------------------
		// 2. Ryanair standing in for a real flight source (keyless — see this file's
		//    header) on the KEF -> OSL -> TBS pairing.
		// -----------------------------------------------------------------
		// One endpoint, not two: since issue #121 the adapter reads the route graph off
		// the same active-airports response it reads timezones off, and no longer asks
		// /views/locate/searchWidget/routes/en/airport/{IATA} anything. `routes` entries
		// are prefixed by what they name, so `airport:OSL` is the KEF -> OSL edge.
		//
		// This mocked network is fictional and deliberately so: Ryanair flies none of
		// these three airports. It stands in for "some keyless flight source covers this
		// pairing" so the map has four transfer legs to draw, which is what this test is
		// about, and the FIXTURE names say as much in the payload itself.
		await page.context().route('https://www.ryanair.com/api/views/locate/3/airports/en/active', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([
					{
						iataCode: 'KEF',
						name: FIXTURE_NAMES.airportA,
						timeZone: 'Atlantic/Reykjavik',
						routes: ['airport:OSL']
					},
					{
						iataCode: 'OSL',
						name: FIXTURE_NAMES.airportB,
						timeZone: 'Europe/Oslo',
						routes: ['airport:TBS', 'airport:KEF']
					},
					{
						iataCode: 'TBS',
						name: FIXTURE_NAMES.airportC,
						timeZone: 'Asia/Tbilisi',
						routes: ['airport:OSL']
					}
				])
			})
		);
		await routeRyanairFlights(page.context(), [
			{
				dep: 'KEF',
				arr: 'OSL',
				depDate: '2027-03-08T06:20:00',
				arrDate: '2027-03-08T10:05:00',
				price: FIXTURE_PRICES.first,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[5]
			},
			{
				dep: 'OSL',
				arr: 'TBS',
				depDate: '2027-03-11T09:30:00',
				arrDate: '2027-03-11T16:10:00',
				price: FIXTURE_PRICES.second,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[6]
			}
		]);

		// -----------------------------------------------------------------
		// 2b. Kiwi.com's keyless endpoint, answering with nothing. This spec builds one
		//     exact itinerary by hand out of Ryanair fares so its geometry assertions are
		//     deterministic, and a second flight source contributing real offers would add
		//     stopovers it never asked about. An empty-but-well-formed answer is a real
		//     thing Kiwi returns, and it keeps this test measuring what it is about.
		// -----------------------------------------------------------------
		await mockKiwiPublic(page.context());

		// -----------------------------------------------------------------
		// 2c. Hostelworld's keyless bed source, answering with no cities. Same reasoning as
		//     Kiwi directly above: this spec asserts the geometry of an itinerary it built
		//     by hand, and a priced bed would add a hotel marker to the very map it is
		//     counting markers on. It is registered rather than omitted because the adapter
		//     is keyless and therefore always runs — an unanswered host is a blocked request,
		//     not a quiet skip.
		// -----------------------------------------------------------------
		await mockHostelworld(page.context());

		// -----------------------------------------------------------------
		// 3. Transitous: no transit anywhere, so OSRM's walking route always wins
		//    `pickBestTransfer`'s mode preference (resources.ts) — the deterministic
		//    setup this test's geometry assertions depend on.
		// -----------------------------------------------------------------
		await page.context().route('https://api.transitous.org/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ itineraries: [] }) })
		);

		// -----------------------------------------------------------------
		// 4. OSRM (routing.openstreetmap.de — see osrm.ts's own header for why this
		//    adapter uses this host, not router.project-osrm.org). Every `/route/`
		//    request gets a real-shaped three-point GeoJSON LineString EXCEPT the
		//    origin-location <-> KEF-airport leg, which gets no `geometry` field at all
		//    — the "OSRM couldn't produce a shape" case the schematic fallback exists
		//    for.
		// -----------------------------------------------------------------
		const osrmRouteRequests: string[] = [];
		await page.context().route('https://routing.openstreetmap.de/**', async (route) => {
			const url = new URL(route.request().url());
			if (!url.pathname.includes('/route/')) {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ code: 'Ok', waypoints: [{ name: `${FIXTURE_NAMES.airportA} approach` }] })
				});
				return;
			}
			osrmRouteRequests.push(url.toString());

			const coordsSegment = url.pathname.split('/').pop() ?? '';
			const [fromRaw, toRaw] = coordsSegment.split(';');
			const [fromLon, fromLat] = fromRaw.split(',').map(Number);
			const [toLon, toLat] = toRaw.split(',').map(Number);
			const from = { lat: fromLat, lon: fromLon };
			const to = { lat: toLat, lon: toLon };

			const routes: Record<string, unknown>[] = [{ distance: 3000, duration: 900 }];
			if (!isOriginAirportLeg(from, to)) {
				const midLat = (from.lat + to.lat) / 2 + 0.01;
				const midLon = (from.lon + to.lon) / 2;
				routes[0].geometry = {
					type: 'LineString',
					coordinates: [
						[from.lon, from.lat],
						[midLon, midLat],
						[to.lon, to.lat]
					]
				};
			}
			await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'Ok', routes }) });
		});

		// -----------------------------------------------------------------
		// 5. Keyless CARTO basemap — same empty style result-detail.spec.ts uses,
		//    enough for MapLibre's own `load` event without pulling real vector tiles.
		// -----------------------------------------------------------------
		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

		// -----------------------------------------------------------------
		// 6. The search itself, plus an origin and a destination location so all four
		//    transfer legs have somewhere to go.
		// -----------------------------------------------------------------
		const params = new URLSearchParams({
			dep: '2027-03-08',
			arr: '2027-03-15',
			from: 'KEF',
			to: 'TBS',
			via: 'OSL',
			fromLoc: `FIXTURE start point@${KEF_LOC.lat},${KEF_LOC.lon}`,
			toLoc: `FIXTURE end point@${TBS_LOC.lat},${TBS_LOC.lon}`
		});
		await page.goto(`/results/?${params}`);
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();
		await expect(card).toContainText('OSL');

		await page.getByRole('button', { name: 'Show details' }).first().click();
		const detail = page.locator('.result-detail');
		await expect(detail).toBeVisible();
		await expect(detail.getByRole('region', { name: /Route map/ })).toBeVisible();

		// Every OSRM route request this search made asked for a simplified GeoJSON
		// overview — a parameter on a request already being made (this PR's whole
		// premise), never an extra one.
		expect(osrmRouteRequests.length).toBeGreaterThan(0);
		for (const requested of osrmRouteRequests) {
			expect(requested).toContain('overview=simplified');
			expect(requested).toContain('geometries=geojson');
		}
		expect(bookingSearches.length).toBeGreaterThan(0);

		// -----------------------------------------------------------------
		// All four transfer legs plus both flights are real rows in the timeline —
		// proving the pipeline actually populated transferToOriginAirport,
		// transferToHotel, transferToConnectionAirport and transferToDestinationLocation
		// together, not just that segments.ts *could* draw them from a hand-built
		// fixture.
		// -----------------------------------------------------------------
		const timeline = detail.locator('.itinerary-timeline');
		await expect(timeline).toBeVisible();
		for (const segment of [
			'transfer-to-origin-airport',
			'transfer-to-hotel',
			'transfer-to-connection-airport',
			'transfer-to-destination-location'
		]) {
			await expect(timeline.locator(`[data-segment="${segment}"]`)).toBeVisible();
		}

		// -----------------------------------------------------------------
		// Distinct markers (issue #118's other half): start/hotel/end read as a
		// different silhouette from an airport, not just a differently-tinted dot.
		// Three of each — origin/connection/destination airports vs. the origin
		// location, the hotel and the destination location.
		// -----------------------------------------------------------------
		const map = detail.locator('.itinerary-map-canvas');
		await expect(map.locator('.itinerary-marker-pin')).toHaveCount(3);
		await expect(map.locator('.itinerary-marker:not(.itinerary-marker-pin)')).toHaveCount(3);

		// -----------------------------------------------------------------
		// Honest geometry, proven both ways in one real pipeline run: the connection
		// transfer (real OSRM shape) never gets the "straight-line estimate" caveat,
		// while the one leg OSRM answered with no geometry at all does — read off the
		// live region ItineraryMap announces a selection through — which issue #141 made
		// visible as the caption under the map, so it is no longer `.visually-hidden`.
		// -----------------------------------------------------------------
		const announcement = detail.locator('.map-status[role="status"]');

		await timeline.locator('[data-segment="transfer-to-hotel"]').click();
		await expect(announcement).toContainText(`Transfer to ${FIXTURE_NAMES.property}`);
		await expect(announcement).not.toContainText('straight-line estimate');

		await timeline.locator('[data-segment="transfer-to-origin-airport"]').click();
		await expect(announcement).toContainText('Transfer to KEF');
		await expect(announcement).toContainText('straight-line estimate');
	});
});
