/**
 * Invariant: the recording still answers the questions this app asks.
 *
 * Not an invariant about the app. An invariant about the suite, and it sorts first on
 * purpose so its failure is the one a reader sees at the top.
 *
 * The whole of `pnpm qa` is worth nothing the moment an adapter starts calling an endpoint
 * the bench does not answer, and the way that failure presents is genuinely misleading. It
 * happened on this suite's own first CI run: #166 landed 48 seconds before the run started,
 * moving Ryanair's fares from `oneWayFares?departureAirportIataCode=` to
 * `oneWayFares/{from}/{to}/cheapestPerDay` plus a second `timtbl/3/schedules` call. The
 * bench answered the old shape, every fare came back empty, and three behavioural checks
 * failed at their "is there anything on screen to check" line. Read from the outside, that
 * is a report of three broken invariants — a cache that does not paint, a card quoting two
 * currencies, a fabricated itinerary — and not one of them had happened. Nothing on that
 * run ever reached an assertion about behaviour at all.
 *
 * So this check states the precondition the others rest on, in the terms that name the
 * cause: which endpoints were asked, which of them the bench had an answer for, and whether
 * a search built anything out of them.
 */

import { test, expect } from './support/bench';
import { resultsUrl } from './support/scenario';
import { resultCards, waitForSearchToFinish } from './support/page';

test.describe('the bench still answers this app', () => {
	test('a recorded search produces itineraries', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);

		const ryanairRequests = bench.requests.filter((request) => request.providerId === 'ryanair');
		expect(
			ryanairRequests.length,
			'the search never asked Ryanair anything, so nothing downstream of it can be measured'
		).toBeGreaterThan(0);

		// A body per request is the tell. `#recordedBodyFor` aborts a request it has no
		// answer for and pushes the URL onto `unrecognised`, so an endpoint that moved shows
		// up here as a request with no body long before it shows up as an empty screen.
		const answered = bench.bodies.filter((body) => body.providerId === 'ryanair').length;
		expect(
			answered,
			[
				`Ryanair was asked ${ryanairRequests.length} question(s) and the bench answered ${answered} of them.`,
				'',
				'What it was asked:',
				...[...new Set(ryanairRequests.map((request) => new URL(request.url).pathname))].map((path) => `  ${path}`),
				'',
				'An endpoint the adapter calls and this bench does not answer is a stale recording,',
				'not a defect in the app. tests/qa/support/responses.ts is where it is fixed.'
			].join('\n')
		).toBe(ryanairRequests.length);

		expect(
			await resultCards(page).count(),
			[
				'The scenario search rendered no itineraries at all.',
				'',
				'Every provider this search touched:',
				bench.describeTraffic(),
				'',
				'Every other check in this suite asserts something about a rendered itinerary, so',
				'they will all fail at their first line and none of them will have measured the',
				'behaviour it is named for. Fix this one first, and read the other failures only',
				'once it passes.'
			].join('\n')
		).toBeGreaterThan(0);
	});
});
