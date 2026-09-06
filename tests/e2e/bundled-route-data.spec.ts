import { test, expect } from './support/fixtures';
import { FALLBACK_ROUTES } from '../../src/lib/algorithm/connections-fallback-data';
import { DEFAULT_ACTIVE_AIRPORTS_FIXTURE, readAirportFixture } from './support/bundled-data';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * The suite's own premise: a search considers the airports this repo names, and no others.
 *
 * Issue #379. Every provider is mocked and `network-guard.ts` blocks the rest, which made it
 * look as though these specs owned their world. They did not. Three route datasets ship
 * inside the bundle and reach `algorithm/connections.ts` through a plain dynamic `import()`,
 * so a spec whose fixture named fourteen airports was ranking candidates against 224 Ryanair
 * airports and a 309-airport graph vendored from Wikipedia. #361 widened the second of those
 * and three unrelated specs broke on the same afternoon.
 *
 * `support/bundled-data.ts` answers those three chunks now, and this is the check that says
 * so. Without it the fix would be invisible: every other spec passes whether the pin works or
 * not, which is the shape issue #382 is about. It reads the traffic rather than the screen,
 * because "which airports did this search think about" is a question the page only partly
 * answers.
 *
 * ## The two sources this allows, and why the list is not just the fixture
 *
 * `connections.ts` ranks candidates from four bundled sources, and only three of them are
 * JSON chunks. The fourth is `FALLBACK_ROUTES`, eighteen airports and a few dozen edges
 * hand-written in `src/lib/algorithm/connections-fallback-data.ts` and compiled into the
 * app, so nothing served over the wire can answer for it. It does not need to be: it is what
 * #379 is not about. The three chunks are regenerated on a schedule by CI, which is how the
 * graph widened under three specs overnight. This table is edited by a person and moves when
 * somebody moves it.
 *
 * So the universe is the fixture plus that table, and both are hand-written files a reader
 * can open. The check still has its teeth: of the eight airports the real shipped graph put
 * into this question before the pin, namely BTS, CGN, EIN, HAJ, HHN, NUE, OSR and RTM, the
 * table names none.
 */

const RESULTS_URL = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';

/** Both Kiwi questions land here, told apart by `?featureName=`. */
const KIWI_ENDPOINT = 'https://api.skypicker.com/umbrella/v2/graphql**';

/**
 * Reads the airport pair out of a Kiwi GraphQL body, the way
 * `tests/qa/route-graph-fanout.qa.ts` does. `anywhere` is the magic id the app sends for "no
 * destination filter", which is the "where does this airport fly at all" question.
 */
function pairsAsked(bodies: readonly string[]): string[] {
	return bodies.map((body) => {
		const [source, destination] = [
			/"source":\{"ids":\["Station:airport:([A-Z]{3})"\]/,
			/"destination":\{"ids":\["Station:airport:([A-Z]{3})"\]/
		].map((pattern) => pattern.exec(body)?.[1]);
		return `${source ?? '??'}->${destination ?? (body.includes('"anywhere"') ? '*' : '??')}`;
	});
}

test('a search asks about the airports this repo names, and no others', async ({ page }) => {
	await mockAllKeylessProviders(page.context());
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
			dep: 'VIE',
			arr: 'TLL',
			depDate: '2027-03-10T11:00:00',
			arrDate: '2027-03-10T13:20:00',
			price: FIXTURE_PRICES.third,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
		}
	]);

	// Registered after the Kiwi mock so Playwright offers it the request first, and falls
	// through to it: this reads the traffic without answering any of it.
	const bodies: string[] = [];
	await page.context().route(KIWI_ENDPOINT, async (route) => {
		bodies.push(route.request().postData() ?? '');
		await route.fallback();
	});

	await page.goto(RESULTS_URL);
	await waitForSearchToSettle(page, { timeout: 20_000 });

	const asked = pairsAsked(bodies).sort();
	const codes = [...new Set(asked.flatMap((pair) => pair.split('->')))].filter(
		(code) => code !== '*'
	);

	// The premise before the claim: a search that asked about nothing, or only about its own
	// origin, satisfies any statement about which airports it asked about. Issue #382.
	expect(
		codes.length,
		`this search asked Kiwi about ${codes.length} airport(s), so it never fanned out`
	).toBeGreaterThan(2);

	const declared = new Set([
		...readAirportFixture(DEFAULT_ACTIVE_AIRPORTS_FIXTURE).map((airport) => airport.iataCode),
		...FALLBACK_ROUTES.keys(),
		...[...FALLBACK_ROUTES.values()].flatMap((destinations) => [...destinations])
	]);
	const strangers = codes.filter((code) => !declared.has(code)).sort();

	expect(
		strangers,
		[
			`This search asked Kiwi about ${strangers.join(', ')}, which neither ` +
				`${DEFAULT_ACTIVE_AIRPORTS_FIXTURE} nor connections-fallback-data.ts names.`,
			'',
			'A generated route dataset is being read instead of answered, which is issue #379',
			'coming back. Check that support/bundled-data.ts still finds all three chunks in',
			"Vite's build manifest.",
			'',
			`Asked (${asked.length}):`,
			...asked.map((pair) => `  ${pair}`)
		].join('\n')
	).toEqual([]);
});
