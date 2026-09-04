import { test, expect } from './support/fixtures';
import { mockAllKeylessProviders, OSRM_BASE_URL } from './support/providers';

/**
 * Issue #132: `mockOsrm` used to intercept `router.project-osrm.org`, a host
 * `src/lib/providers/transfers/osrm.ts` stopped calling once it moved to
 * `routing.openstreetmap.de` (see that file's own header comment for why). No spec ever
 * called `mockOsrm` with a query that actually triggers an OSRM request, so the drift sat
 * unnoticed: the next spec to reach for it would silently miss its own mock and either hit
 * the real, volunteer-run demo server or get aborted by the network guard, depending on
 * that server's mood.
 *
 * `mockOsrm` now derives its intercept pattern from `OSRM_BASE_URL`, exported by the
 * adapter itself, so the two cannot drift apart again — but that structural fix still
 * needs a spec that actually sends OSRM a request to prove it. The only thing that makes
 * `search/pipeline.ts` call a `TransferProvider` at all is an origin or destination
 * *location* on the query (`fetchOuterTransfers`, gated on `query.originLocation` /
 * `query.destinationLocation`) — an airport code alone never does — so this search adds a
 * `fromLoc` on top of the exact BCN -> VIE -> TLL setup `select-and-compare.spec.ts`
 * already knows produces a real connecting itinerary.
 */

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

test.describe('mockOsrm intercepts the host the adapter really calls (issue #132)', () => {
	test('a search with an origin location sends every OSRM request through the mock, never the retired host', async ({
		page
	}) => {
		const requestedUrls: string[] = [];
		page.context().on('request', (request) => requestedUrls.push(request.url()));

		// Ryanair route-widget, active-airports and OSRM all keep their generic default
		// fixtures — only the fare-finder below needs to be query-aware, exactly as
		// select-and-compare.spec.ts already established for this same BCN -> VIE -> TLL
		// pairing. `mockOsrm` here is the one thing this test exists to exercise.
		await mockAllKeylessProviders(page.context());

		await page.context().route('https://services-api.ryanair.com/**', async (route) => {
			const url = new URL(route.request().url());
			const dep = url.searchParams.get('departureAirportIataCode');
			const arr = url.searchParams.get('arrivalAirportIataCode');
			let fares: unknown[] = [];
			if (dep === 'BCN' && (arr === 'VIE' || !arr)) {
				fares = [
					ryanairFare({ dep: 'BCN', arr: 'VIE', depDate: '2026-10-01T08:00:00', arrDate: '2026-10-01T10:15:00', price: 39.99, flightNumber: 'FR1001' })
				];
			} else if (dep === 'VIE' && (arr === 'TLL' || !arr)) {
				fares = [
					ryanairFare({ dep: 'VIE', arr: 'TLL', depDate: '2026-10-03T11:00:00', arrDate: '2026-10-03T13:20:00', price: 45, flightNumber: 'FR2001' })
				];
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ fares, size: fares.length, currency: 'EUR' })
			});
		});

		const params = new URLSearchParams({
			dep: '2026-10-01',
			arr: '2026-10-20',
			from: 'BCN',
			to: 'TLL',
			fromLoc: 'Barcelona city centre@41.3851,2.1734'
		});
		await page.goto(`/results/?${params}`);
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		// The property issue #132 broke silently: a request that was meant for OSRM must
		// actually land on the host mockOsrm intercepts, not on the host this adapter
		// retired. Checking both directions means a regression here fails for the right
		// reason instead of coincidentally passing because nothing called OSRM at all.
		const osrmRequests = requestedUrls.filter((url) => url.startsWith(OSRM_BASE_URL));
		expect(osrmRequests.length, `expected at least one request through mockOsrm's host, saw: ${requestedUrls.join(', ')}`).toBeGreaterThan(0);

		const retiredHostRequests = requestedUrls.filter((url) => url.includes('router.project-osrm.org'));
		expect(retiredHostRequests, 'no request should ever reach the OSRM host this adapter no longer calls').toEqual([]);
	});
});
