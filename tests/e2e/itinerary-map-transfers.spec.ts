import { test, expect } from './support/fixtures';

/**
 * Issue #118: the owner's own complaint, verified against a real search end to end
 * rather than a hand-built fixture — "the map is wrong! i dont want just a map of the
 * flights i want also the transport from starting point to airport, in the conection
 * travel to and from hotel and to destination point, with markers for start hotel and
 * end". Uses his own reference route (docs/prompts/007-morning-review.md): BVC -> PFO,
 * connecting through LGW, 6-12 October 2026 — with an origin and destination location
 * added on top (the brief's own route never needed one) specifically so all four
 * transfer legs exist to check, not just the two connection-side ones.
 *
 * Ryanair stands in for Skyscanner here (keyless, no RapidAPI key needed) purely as a
 * source of matching flight offers for this fictional BVC-LGW-PFO pairing — the same
 * substitution `select-and-compare.spec.ts` already makes for its own route. Booking.com
 * gets a real (fake) key through the settings UI so a stay actually prices, which is what
 * makes `transferToHotel`/`transferToConnectionAirport` exist at all (issue #94's "all
 * three together or none").
 *
 * One OSRM leg (origin location -> BVC) is deliberately mocked WITHOUT a `geometry`
 * field, so this test proves both branches of the honest-geometry decision in one real
 * pipeline run: the three legs OSRM answers with a shape render as real routes (no
 * "(straight-line estimate)" caveat), and the one leg it doesn't render as the honest
 * schematic fallback instead.
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
			departureAirport: { countryName: 'Test', iataCode: dep, name: dep, seoName: dep.toLowerCase() },
			arrivalAirport: { countryName: 'Test', iataCode: arr, name: arr, seoName: arr.toLowerCase() },
			departureDate: depDate,
			arrivalDate: arrDate,
			price: { value: price, valueMainUnit: whole, valueFractionalUnit: frac, currencySymbol: '€', currencyCode: 'EUR' },
			flightNumber,
			flightKey: `FR~${flightNumber}~~${dep}~${arr}~${depDate.slice(0, 10)}~${depDate.slice(0, 10)}~1`,
			previousPrice: null
		}
	};
}

// Real-ish, but fixed, coordinates so this test controls exactly which OSRM request
// answers which leg rather than depending on the live demo server's actual road network.
const BVC_APT = { lat: 16.1365, lon: -22.8889 }; // Aristides Pereira Intl, Boa Vista
const BVC_LOC = { lat: 16.1797, lon: -22.9174 }; // Sal Rei, same island, ~7km away
const LGW_APT = { lat: 51.1481, lon: -0.1903 }; // London Gatwick
const LGW_HOTEL = { lat: 51.1235, lon: -0.169 }; // A stand-in for Gainsborough Lodge
const PFO_APT = { lat: 34.718, lon: 32.4857 }; // Paphos Intl
const PFO_LOC = { lat: 34.772, lon: 32.4297 }; // Paphos old town, ~8km away

function roughlyMatches(a: number, b: number): boolean {
	return Math.abs(a - b) < 0.01;
}

/** `true` when the two endpoints an OSRM `/route/` request names are (in either order)
 *  the origin-location <-> BVC-airport pair — the one leg this test deliberately answers
 *  with no route shape, to prove the schematic fallback still works inside a real
 *  pipeline run. */
function isOriginAirportLeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean {
	const matches = (p: { lat: number; lon: number }, q: { lat: number; lon: number }) =>
		roughlyMatches(p.lat, q.lat) && roughlyMatches(p.lon, q.lon);
	return (matches(a, BVC_LOC) && matches(b, BVC_APT)) || (matches(a, BVC_APT) && matches(b, BVC_LOC));
}

test.describe('itinerary map: every transfer leg, distinct markers, honest geometry (issue #118)', () => {
	test('a real search draws all four transfers, marks start/hotel/end distinctly from airports, and only labels the leg with no OSRM shape as an estimate', async ({
		page
	}) => {
		// -----------------------------------------------------------------
		// 1. A (fake) Booking.com key, through the real settings UI — Booking's own
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
									room_name: 'Private Double Room',
									is_dormitory: 0,
									product_price_breakdown: { gross_amount_per_night: { value: 44, currency: 'EUR' } }
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
								hotel_name: 'Gainsborough Lodge',
								latitude: LGW_HOTEL.lat,
								longitude: LGW_HOTEL.lon,
								composite_price_breakdown: { gross_amount_per_night: { value: 44, currency: 'EUR' } }
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
		//    header) on the owner's own BVC -> LGW -> PFO pairing.
		// -----------------------------------------------------------------
		// One endpoint, not two: since issue #121 the adapter reads the route graph off
		// the same active-airports response it reads timezones off, and no longer asks
		// /views/locate/searchWidget/routes/en/airport/{IATA} anything. `routes` entries
		// are prefixed by what they name, so `airport:LGW` is the BVC -> LGW edge.
		//
		// This mocked network is fictional and deliberately so: the real Ryanair serves
		// none of BVC, RAI or SID (docs/ACCEPTANCE.md), and LGW's four Ryanair
		// destinations do not include PFO. It stands in for "some keyless flight source
		// covers this pairing" so the map has four transfer legs to draw, which is what
		// this test is about.
		await page.context().route('https://www.ryanair.com/api/views/locate/3/airports/en/active', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([
					{ iataCode: 'BVC', timeZone: 'Atlantic/Cape_Verde', routes: ['airport:LGW'] },
					{ iataCode: 'LGW', timeZone: 'Europe/London', routes: ['airport:PFO', 'airport:BVC'] },
					{ iataCode: 'PFO', timeZone: 'Asia/Nicosia', routes: ['airport:LGW'] }
				])
			})
		);
		await page.context().route('https://services-api.ryanair.com/**', async (route) => {
			const url = new URL(route.request().url());
			const dep = url.searchParams.get('departureAirportIataCode');
			const arr = url.searchParams.get('arrivalAirportIataCode');
			let fares: unknown[] = [];
			if (dep === 'BVC' && (arr === 'LGW' || !arr)) {
				fares = [
					ryanairFare({
						dep: 'BVC',
						arr: 'LGW',
						depDate: '2026-10-06T12:40:00',
						arrDate: '2026-10-06T20:30:00',
						price: 149,
						flightNumber: 'FR7001'
					})
				];
			} else if (dep === 'LGW' && (arr === 'PFO' || !arr)) {
				fares = [
					ryanairFare({
						dep: 'LGW',
						arr: 'PFO',
						depDate: '2026-10-07T15:20:00',
						arrDate: '2026-10-07T22:00:00',
						price: 89,
						flightNumber: 'FR7002'
					})
				];
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ fares, size: fares.length, currency: 'EUR' })
			});
		});

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
		//    origin-location <-> BVC-airport leg, which gets no `geometry` field at all
		//    — the "OSRM couldn't produce a shape" case the schematic fallback exists
		//    for.
		// -----------------------------------------------------------------
		const osrmRouteRequests: string[] = [];
		await page.context().route('https://routing.openstreetmap.de/**', async (route) => {
			const url = new URL(route.request().url());
			if (!url.pathname.includes('/route/')) {
				await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'Ok', waypoints: [{}] }) });
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
		// 5. Keyless CARTO basemap — same empty style select-and-compare.spec.ts uses,
		//    enough for MapLibre's own `load` event without pulling real vector tiles.
		// -----------------------------------------------------------------
		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

		// -----------------------------------------------------------------
		// 6. The search itself: the owner's route and dates, plus an origin and
		//    destination location so all four transfer legs have somewhere to go.
		// -----------------------------------------------------------------
		const params = new URLSearchParams({
			dep: '2026-10-06',
			arr: '2026-10-12',
			from: 'BVC',
			to: 'PFO',
			via: 'LGW',
			fromLoc: `Sal Rei@${BVC_LOC.lat},${BVC_LOC.lon}`,
			toLoc: `Paphos old town@${PFO_LOC.lat},${PFO_LOC.lon}`
		});
		await page.goto(`/results/?${params}`);
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();
		await expect(card).toContainText('LGW');

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
		// live region ItineraryMap announces a selection through.
		// -----------------------------------------------------------------
		const announcement = detail.locator('[role="status"].visually-hidden');

		await timeline.locator('[data-segment="transfer-to-hotel"]').click();
		await expect(announcement).toContainText('Transfer to Gainsborough Lodge');
		await expect(announcement).not.toContainText('straight-line estimate');

		await timeline.locator('[data-segment="transfer-to-origin-airport"]').click();
		await expect(announcement).toContainText('Transfer to BVC');
		await expect(announcement).toContainText('straight-line estimate');
	});
});
