/**
 * Invariant: a search asks about a bounded number of airports, and a reload asks about none.
 *
 * Issue #187. `algorithm/connections.ts` used to request a route graph for every airport the
 * origin flies to and then keep six of them. BCN unions 79 resolvable outbound airports
 * across Ryanair's bundled snapshot, the cheap-routes dataset and the fallback table, and
 * STN unions 179, so that is hundreds of questions for six answers, against providers nobody
 * pays for and cannot afford to be blocked by.
 *
 * `cost-per-search.qa.ts` already budgets the total per provider, and it did not catch this:
 * `kiwi-public.ts` had grown a private ceiling of 20 route lookups a session, so the total
 * looked bounded while the fan-out underneath it was not. What the ceiling actually did was
 * decide the search gave up partway through the candidate list, at a different point on
 * every load. So this file counts the route-graph half on its own, which is the number that
 * moves when somebody removes the ranking.
 *
 * The second check is the one that matters most, and it is why issue #194 was the same bug.
 * A bounded fan-out is also a DETERMINISTIC one: geography ranks the candidates, geography
 * comes from a bundled dataset, so load one asks about exactly the set load two will want.
 * An unbounded loop can never reach that state, because no load ever caches all of it.
 */

import { test, expect } from './support/bench';
import { KIWI_PUBLIC_HOST } from './support/catalog';
import { resultsUrl } from './support/scenario';
import { resultCards, waitForSearchToFinish } from './support/page';

/**
 * `ROUTE_PROBES_PER_KEPT_CANDIDATE` (3) times `DEFAULT_MAX_CANDIDATES` (6), which is the
 * ceiling `connections.ts` sets, plus one for the origin's own lookup. A search that stays
 * under this is doing what it says; one that goes over has found a second fan-out somewhere.
 *
 * Deliberately the arithmetic rather than the 12 this scenario measures today. A number
 * copied from current behaviour can only ratify it, and the point is the shape.
 */
const MAX_ROUTE_LOOKUPS = 6 * 3 + 1;

/** Kiwi's route graph comes from `OnePerCityItinerariesQuery`; its fares come from
 * `SearchOneWayItinerariesQuery` down the same URL. Only the first is this file's business. */
function routeGraphLookups(requests: readonly { url: string }[]): string[] {
	return requests
		.filter((request) => request.url.includes(KIWI_PUBLIC_HOST))
		.filter((request) => request.url.includes('OnePerCityItinerariesQuery'))
		.map((request) => request.url);
}

test.describe('route-graph fan-out', () => {
	test('one search asks a bounded number of airports for their routes', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);

		const lookups = routeGraphLookups(bench.requests);
		expect(
			lookups.length,
			[
				`One cold search made ${lookups.length} route-graph lookups; the ceiling is ${MAX_ROUTE_LOOKUPS}.`,
				'',
				'connections.ts ranks candidates on geography, which costs nothing, and asks only',
				'the top ROUTE_PROBES_PER_KEPT_CANDIDATE * maxCandidates of them. Going over means',
				'either that ranking is gone or something else is asking per candidate.',
				'',
				'Everything this search touched:',
				bench.describeTraffic()
			].join('\n')
		).toBeLessThanOrEqual(MAX_ROUTE_LOOKUPS);
	});

	test('a reload asks about no airport the first search already asked about', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.clock.install({ time: new Date('2026-09-20T09:00:00Z') });
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);
		expect(await resultCards(page).count(), 'the first search found nothing to cache').toBeGreaterThan(0);

		bench.resetLog();
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);

		const lookups = routeGraphLookups(bench.requests);
		expect(
			lookups,
			[
				`A reload one minute later made ${lookups.length} route-graph lookups. It should make none:`,
				'the route graph has a 24-hour TTL and the first load just cached it.',
				'',
				'Any number above zero means the two loads asked about DIFFERENT airports, which is',
				'what an unbounded fan-out plus a per-provider ceiling produces — the ceiling stops',
				'the search partway through the candidate list and the page resets the counter, so',
				'load two asks about the ones load one never reached. That is issue #194: each of',
				'those misses is awaited in turn and nothing paints until they are done.',
				'',
				...lookups.map((url) => `  ${url}`)
			].join('\n')
		).toEqual([]);
	});
});
