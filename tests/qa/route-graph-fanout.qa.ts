/**
 * Invariant: a search asks about a bounded number of airports, it asks about the ones this
 * scenario names and no others, and a reload asks about none.
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
 * The reload check is the one that matters most, and it is why issue #194 was the same bug.
 * A bounded fan-out is also a DETERMINISTIC one: geography ranks the candidates, geography
 * comes from a bundled dataset, so load one asks about exactly the set load two will want.
 * An unbounded loop can never reach that state, because no load ever caches all of it.
 */

import { test, expect } from './support/bench';
import type { RecordedRequest } from './support/bench';
import { KIWI_PUBLIC_HOST } from './support/catalog';
import { ROUTE_QUESTIONS_ASKED, resultsUrl } from './support/scenario';
import { resultCards, waitForSearchToSettle } from './support/page';
import {
	DEFAULT_MAX_CANDIDATES,
	ROUTE_PROBES_PER_KEPT_CANDIDATE
} from '../../src/lib/algorithm/connections';

/**
 * The most route questions one cold search can put to one source: a ranked position each,
 * plus the origin's own outbound lookup.
 *
 * This used to be spelled `6 * 3 + 1`, two literals standing in for two exported constants,
 * so raising either in `connections.ts` left this ceiling silently measuring the old one.
 * Issue #378, and the reason it is imported now rather than typed out.
 *
 * The arithmetic is exact, and it rests on two facts rather than on a number anybody
 * observed. `maxRouteProbes` bounds ranked POSITIONS — `connections.ts` compares it against
 * the loop index — and one position asks one source at most one question, because every
 * candidate arrives with one of its two legs already proven. `connections.test.ts` holds
 * that second half directly ("asks at most one route question about any one candidate"),
 * which is what keeps this line from being an observation in the shape of a proof.
 *
 * A ceiling is not a prediction. `ROUTE_QUESTIONS_ASKED` is what this scenario actually
 * asks, and that is the number a regression moves first.
 *
 * What this still cannot see is the defect issue #255 was about. The scenario ranks twelve
 * candidates against eighteen positions, so a ceiling that cuts live cities looks identical
 * here to one that cuts nothing, and #248 could report "itineraries unchanged at 4" in good
 * faith. The check that does see it is a unit test in `algorithm/connections.test.ts`,
 * "still asks the bundled route graph about a candidate it has no request budget left for".
 * That sentence was in this file before issue #379 and was false when it was written: the
 * candidate set came from shipped data rather than from a fixture, and was 49 long.
 */
const MAX_ROUTE_LOOKUPS = DEFAULT_MAX_CANDIDATES * ROUTE_PROBES_PER_KEPT_CANDIDATE + 1;

/**
 * Kiwi's route knowledge comes from two queries down the same URL, and its fares from a
 * third. Both of the first two are this file's business, and issue #340 is why the second
 * one is named here.
 *
 * `OnePerCityItinerariesQuery` asks "where does this airport fly", and `DirectRouteCheckQuery`
 * asks "does it fly HERE" — the question #340 replaced the first one with for the candidate
 * loop, because one row per destination city is a sample and the loop was reading it as a
 * network. Both spend one request per airport, so both are fan-out, and counting only the
 * older one would have left this ceiling measuring traffic the search had stopped making.
 *
 * `SearchOneWayItinerariesQuery`, the fare search, stays out: it is priced per itinerary
 * rather than per candidate, and `cost-per-search.qa.ts` is what bounds it.
 */
function routeGraphLookups(requests: readonly RecordedRequest[]): RecordedRequest[] {
	return requests
		.filter((request) => request.url.includes(KIWI_PUBLIC_HOST))
		.filter(
			(request) =>
				request.url.includes('OnePerCityItinerariesQuery') ||
				request.url.includes('DirectRouteCheckQuery')
		);
}

/**
 * The pair each lookup asked about, as `FROM->TO`, or `FROM->*` for the "where does this
 * airport fly at all" query.
 *
 * The airports are in the GraphQL variables rather than the URL, which is why `bench.ts`
 * keeps the request body. A count on its own is what issue #378 called an observation
 * dressed as arithmetic; the pairs are what make the count explainable.
 */
function pairsAsked(requests: readonly RecordedRequest[]): string[] {
	return routeGraphLookups(requests).map((request) => {
		const variables = request.postData ?? '';
		const [source, destination] = [
			/"source":\{"ids":\["Station:airport:([A-Z]{3})"\]/,
			/"destination":\{"ids":\["Station:airport:([A-Z]{3})"\]/
		].map((pattern) => pattern.exec(variables)?.[1]);
		// `anywhere` is the magic id `buildOnePerCityVariables` sends for "no destination
		// filter", which is the "where does this airport fly at all" question.
		return `${source ?? '??'}->${destination ?? (variables.includes('"anywhere"') ? '*' : '??')}`;
	});
}

test.describe('route-graph fan-out', () => {
	test('one search asks a bounded number of airports for their routes', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);

		const lookups = routeGraphLookups(bench.requests);
		expect(
			lookups.length,
			[
				`One cold search made ${lookups.length} route-graph lookups; the ceiling is ${MAX_ROUTE_LOOKUPS}.`,
				'',
				'connections.ts ranks candidates on geography, which costs nothing, and walks only',
				'the top ROUTE_PROBES_PER_KEPT_CANDIDATE * maxCandidates of them, asking each at',
				'most one question. Going over means either that ranking is gone, or a candidate',
				'is now reaching the loop with neither leg proven and paying for both.',
				'',
				'Everything this search touched:',
				bench.describeTraffic()
			].join('\n')
		).toBeLessThanOrEqual(MAX_ROUTE_LOOKUPS);
	});

	test('one search asks about the airports this scenario names and no others', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);

		const asked = pairsAsked(bench.requests).sort();
		expect(
			asked,
			[
				'A cold search asked Kiwi about a different set of pairs than the scenario declares.',
				'',
				'This is issue #379. Until it was fixed the bench let three bundled JSON datasets',
				'through as ordinary app assets, so this scenario ranked against the real Ryanair',
				'snapshot of 224 airports while its fixture described seven, and nobody could',
				'see it. If this list has grown, ask which source it grew from before widening',
				'ROUTE_QUESTIONS_ASKED — a fixture that is edited until the symptom goes away is',
				'exactly what #379 is about.',
				'',
				`Asked (${asked.length}):`,
				...asked.map((pair) => `  ${pair}`)
			].join('\n')
		).toEqual([...ROUTE_QUESTIONS_ASKED].sort());
	});

	test('a reload asks about no airport the first search already asked about', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.clock.install({ time: new Date('2026-09-20T09:00:00Z') });
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);
		expect(await resultCards(page).count(), 'the first search found nothing to cache').toBeGreaterThan(0);

		bench.resetLog();
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);

		const lookups = pairsAsked(bench.requests);
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
				...lookups.map((pair) => `  ${pair}`)
			].join('\n')
		).toEqual([]);
	});
});
