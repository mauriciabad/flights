import { test } from './support/fixtures';

/**
 * Search: the first two scenarios from issue #18. Both need the search form (#16),
 * somewhere to show results (#23), and a provider adapter to call — none of which
 * exist yet (the app is still the SvelteKit starter page). Left skipped rather than
 * written against guessed selectors, per this issue's own instructions.
 *
 * Once the blockers close, mock providers with the helpers in
 * tests/e2e/support/providers.ts (mockRyanair, mockSkyscanner, ...) before calling
 * page.goto() — never let a real request reach a provider, see tests/e2e/README.md.
 */
test.describe('search', () => {
	test.skip(
		'a first run with no keys configured still returns Ryanair results',
		async () => {
			// Intent (issue #18): "First run with no keys: the app loads, explains itself,
			// and still returns Ryanair results." Ryanair needs no key (docs/prompts/002),
			// so mockRyanair() is the only mock this test needs — and it's worth asserting
			// that Skyscanner/Rome2Rio/Booking are never called at all when the key store
			// is empty, once that logic exists.
			// Blocked on: #3 (key store), #16 (search form), #23 (results list), #6
			// (Ryanair adapter).
		}
	);

	test.skip('entering a RapidAPI key and running a search returns results', async () => {
		// Intent (issue #18): "Enter a key, run a search, get results." Once the settings
		// screen (#29) can store a key and the search form (#16) can submit a query, mock
		// Skyscanner with mockSkyscanner() and assert its fares render alongside
		// Ryanair's.
		// Blocked on: #29 (settings/keys), #16 (search form), #23 (results list), #5
		// (Skyscanner adapter).
	});
});
