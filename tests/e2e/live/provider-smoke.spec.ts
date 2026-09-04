import { expect, test } from '../support/live-fixtures';

/**
 * The `@live` suite: on-demand checks against real provider APIs. Run with
 * `pnpm test:e2e:live` — never in CI, never as part of `pnpm test:e2e` (see
 * tests/e2e/README.md for why, and tests/e2e/support/live-fixtures.ts for the opt-in
 * gate that keeps this from running by accident even then).
 *
 * Most tests below are skipped placeholders naming the provider they will exercise once
 * a way to supply that provider's key in a test environment exists. The exception is the
 * Kiwi one at the bottom, which runs: it needs no key and spends no quota, and it is the
 * only guard this repo has against an undocumented endpoint changing shape underneath a
 * shipped adapter.
 *
 * IMPORTANT once the others stop being skipped: Skyscanner's RapidAPI free tier is 20
 * requests a month, total, for the whole account. That test must run at most a
 * handful of times a month, by a person, on purpose — never in a loop, never as part
 * of automated verification.
 */
test.describe('provider smoke tests', () => {
	test.skip(
		'Ryanair keyless fare search returns real fares',
		{ tag: '@live' },
		async () => {
			// Once the Ryanair adapter (#6) exists: call it directly (no UI needed, this
			// provider takes no key) for a route Ryanair actually flies, and assert it
			// returns at least one fare shaped like the adapter's own return type.
		}
	);

	test.skip(
		'Skyscanner search (RapidAPI) returns real fares — QUOTA: run sparingly, by hand',
		{ tag: '@live' },
		async () => {
			// Once the Skyscanner adapter (#5) and a way to supply a real RapidAPI key in
			// a test environment both exist: run one search and assert it parses into the
			// adapter's return type. One assertion, one call — this is the expensive test
			// in the whole suite.
		}
	);

	test.skip('Rome2Rio (RapidAPI) returns a real transfer plan', { tag: '@live' }, async () => {
		// Once the Rome2Rio adapter (#7) exists: request transfers between a real
		// airport and a real city-centre point, and assert the response parses.
	});

	test.skip('Transitous/MOTIS returns a real transit itinerary', { tag: '@live' }, async () => {
		// Once the Transitous adapter (#8) exists: request a real transit plan between
		// two stops it actually covers, and assert the response parses. No key needed.
	});

	test.skip('OSRM returns a real walking/driving route', { tag: '@live' }, async () => {
		// Once the OSRM adapter (#9) exists: request a real route between two
		// coordinates, and assert the response parses. No key needed.
	});

	test.skip('Booking.com (RapidAPI) returns real hotel results', { tag: '@live' }, async () => {
		// Once the Agoda/Booking stay adapter (#10) exists: search a real city and
		// assert the response parses into the adapter's return type.
	});

	/**
	 * The one live test here that actually runs, because it is the only one that costs
	 * nothing: Kiwi's public endpoint is keyless and unmetered, so there is no quota to
	 * protect and no key to supply.
	 *
	 * It is also the one this project most needs. `providers/flights/kiwi-public.ts` reads
	 * an undocumented endpoint belonging to someone else's website, and its single realistic
	 * failure is Kiwi renaming a field or withdrawing a query — which every unit test in the
	 * repo will keep passing through, because they all run against fixtures captured on the
	 * day it was written. This is what tells you the fixtures have gone stale.
	 *
	 * Runs in a page context rather than in Node so it exercises the real thing: a browser
	 * making a cross-origin request, CORS enforced, from a page origin. Playwright's own
	 * headless User-Agent is overridden in playwright.config.ts for the same reason
	 * docs/PROVIDERS.md gives — Kiwi answers `HeadlessChrome` with a 403 and no CORS headers.
	 */
	test(
		'Kiwi.com public API still answers the shape the adapter was built against',
		{ tag: '@live' },
		async ({ page }) => {
			await page.goto('/');

			const result = await page.evaluate(async () => {
				const response = await fetch(
					'https://api.skypicker.com/umbrella/v2/graphql?featureName=OnePerCityItinerariesQuery',
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							query: `query OnePerCityItinerariesQuery($search: SearchOnewayInput, $filter: ItinerariesFilterInput, $options: ItinerariesOptionsInput) {
								onewayOnePerCityItineraries(search: $search, filter: $filter, options: $options) {
									__typename
									... on AppError { error: message }
									... on OnePerCityItineraries { itineraries { destination { station { code type } } } }
								}
							}`,
							variables: {
								search: {
									itinerary: {
										source: { ids: ['Station:airport:LGW'] },
										destination: { ids: ['anywhere'] },
										outboundDepartureDate: (() => {
											const start = new Date(Date.now() + 14 * 86_400_000);
											const end = new Date(Date.now() + 44 * 86_400_000);
											return {
												start: `${start.toISOString().slice(0, 10)}T00:00:00`,
												end: `${end.toISOString().slice(0, 10)}T23:59:59`
											};
										})()
									},
									passengers: {
										adults: 1,
										children: 0,
										infants: 0,
										adultsHoldBags: [0],
										adultsHandBags: [0],
										childrenHoldBags: [],
										childrenHandBags: []
									},
									cabinClass: { cabinClass: 'ECONOMY', applyMixedClasses: false }
								},
								filter: {
									transportTypes: ['FLIGHT'],
									contentProviders: ['KIWI'],
									maxStopsCount: 0,
									limit: 100,
									flightsApiLimit: 100
								},
								options: {
									sortBy: 'PRICE',
									currency: 'eur',
									locale: 'en',
									partner: 'skypicker',
									affilID: 'skypicker',
									storeSearch: false,
									searchStrategy: 'REDUCED'
								}
							}
						})
					}
				);
				return { status: response.status, body: await response.json() };
			});

			// A 403 here means the bot wall, not a broken adapter — check the User-Agent
			// before assuming Kiwi withdrew the endpoint.
			expect(result.status).toBe(200);
			// A GraphQL `errors` array is the schema-drift signal: a field this adapter asks
			// for no longer exists.
			expect(result.body.errors).toBeUndefined();

			const answer = result.body.data?.onewayOnePerCityItineraries;
			expect(answer?.__typename).toBe('OnePerCityItineraries');

			const codes = (answer?.itineraries ?? [])
				.map((entry: { destination?: { station?: { code?: string; type?: string } } }) =>
					entry.destination?.station?.type === 'AIRPORT' ? entry.destination?.station?.code : undefined
				)
				.filter(Boolean);

			// London Gatwick flies direct to dozens of airports year-round. A handful would
			// mean something changed at Kiwi's end, not that Gatwick shrank.
			expect(codes.length).toBeGreaterThan(20);
		}
	);
});
