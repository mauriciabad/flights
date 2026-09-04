import { test } from './support/fixtures';

/**
 * The comparator (issue #25): pick several itineraries, see them side by side as
 * columns that stay aligned and scroll together on one shared timeline. Nothing to
 * select and nothing to compare exists yet (#23 results list, #24 itinerary timeline),
 * so this stays a skipped placeholder rather than a test against guessed selectors.
 */
test.describe('comparator', () => {
	test.skip('three selected itineraries render as aligned, jointly-scrolling columns', async () => {
		// Intent (issue #18 / brief line 68): open the comparator with three itineraries
		// and check the columns align (CSS subgrid rows matching across columns) and
		// scroll together (one shared timeline, not three independent scroll positions).
		// A reasonable shape for this test once it's real: pick three results, open the
		// comparator, read each column's row boundingBoxes and assert they line up, then
		// scroll one column and assert the others moved with it.
		// Blocked on: #23 (results list), #24 (itinerary timeline), #25 (comparator).
	});
});
