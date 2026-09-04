import { test } from '../support/live-fixtures';

/**
 * The `@live` suite: on-demand checks against real provider APIs. Run with
 * `pnpm test:e2e:live` — never in CI, never as part of `pnpm test:e2e` (see
 * tests/e2e/README.md for why, and tests/e2e/support/live-fixtures.ts for the opt-in
 * gate that keeps this from running by accident even then).
 *
 * Every test below is skipped because no adapter calls these providers from the app
 * yet (issues #5 through #10) — there is nothing for a live test to drive. Each one
 * names the provider it will exercise once its adapter issue closes.
 *
 * IMPORTANT once these stop being skipped: Skyscanner's RapidAPI free tier is 20
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
});
