import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_NAMES, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, OSRM_BASE_URL, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

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
 * `fromLoc` on top of the exact BCN -> VIE -> TLL setup `result-detail.spec.ts`
 * already knows produces a real connecting itinerary.
 *
 * Its fare values come from `support/fixture-markers.ts` for the reason that file
 * explains: realistic shape, worthless numbers, so a mock that escapes this spec cannot be
 * read as a working search.
 */

test.describe('mockOsrm intercepts the host the adapter really calls (issue #132)', () => {
	test('a search with an origin location sends every OSRM request through the mock, never the retired host', async ({
		page
	}) => {
		const requestedUrls: string[] = [];
		page.context().on('request', (request) => requestedUrls.push(request.url()));

		// Ryanair route-widget, active-airports and OSRM all keep their generic default
		// fixtures — only the fare-finder below needs to be query-aware, exactly as
		// result-detail.spec.ts already established for this same BCN -> VIE -> TLL
		// pairing. `mockOsrm` here is the one thing this test exists to exercise.
		await mockAllKeylessProviders(page.context());

		await routeRyanairFlights(page.context(), [
			{
				dep: 'BCN',
				arr: 'VIE',
				depDate: '2027-03-08T08:00:00',
				arrDate: '2027-03-08T10:15:00',
				price: FIXTURE_PRICES.first,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[7]
			},
			{
				dep: 'VIE',
				arr: 'TLL',
				depDate: '2027-03-10T11:00:00',
				arrDate: '2027-03-10T13:20:00',
				price: FIXTURE_PRICES.third,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[8]
			}
		]);

		const params = new URLSearchParams({
			dep: '2027-03-08',
			arr: '2027-03-27',
			from: 'BCN',
			to: 'TLL',
			fromLoc: 'FIXTURE start point@41.3851,2.1734'
		});
		await page.goto(`/results/?${params}`);
		await waitForSearchToSettle(page, { timeout: 20_000 });

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
