/**
 * Invariant: nothing a person is shown as bookable came out of a recording.
 *
 * A fixture that reaches a real screen is a fabricated itinerary with extra steps, and this
 * repo has already produced one — docs/ACCEPTANCE.md records an agent reporting "BVC to LGW
 * to PFO, EUR 238, via Ryanair" for a network that serves none of those airports.
 *
 * The check is on the response, not the pixels, because that is where the answer is
 * unambiguous: an airport name the app renders from its own dataset carries no provenance
 * either way, but a response body either came from a provider or it did not.
 *
 * ## Both modes stay honest
 *
 * `pnpm qa:live` is where the check bites: keyless providers answer for real, and a marker
 * appearing in any body means a recording leaked into the path a person's answer travels.
 *
 * `pnpm qa` serves marked bodies on purpose, so instead it holds up the two things the live
 * check depends on: that the detector fires at all, and that the marking is actually being
 * applied. A safety check that fails open is worse than no check, and both of those are how
 * this one would fail open.
 *
 * The tokens come from `tests/e2e/fixtures/markers.json` by way of `support/markers.ts`, the
 * same manifest `tests/e2e/guard.spec.ts` and `tools/probe-results.mjs` read. This suite has
 * no scheme of its own: a second one would be a second thing to keep in sync and a second
 * way for a leak to slip past.
 */

import { test, expect } from './support/bench';
import { LIVE_MODE } from './support/bench';
import { FIXTURE_TEXT_TOKEN, describeMarkerHits, findTestMarkers, hasTestMarker } from './support/markers';
import { resultsUrl } from './support/scenario';
import { waitForSearchToFinish } from './support/page';

test.describe('no fixture data in a production answer', () => {
	test('the marker detector fires, and only on marked text', () => {
		// A detector that has quietly become a no-op is the failure mode that matters: it
		// would pass every live run while checking nothing.
		expect(hasTestMarker(`${FIXTURE_TEXT_TOKEN} Lodge`)).toBe(true);
		expect(hasTestMarker('Hostel Ruthensteiner')).toBe(false);
		expect(findTestMarkers(`a ${FIXTURE_TEXT_TOKEN} b ${FIXTURE_TEXT_TOKEN}`)).toHaveLength(2);
		// The impossible flight numbers are markers too, and are what a leaked fare shows.
		expect(hasTestMarker('Ryanair ZZ0000')).toBe(true);
	});

	test('no provider response carries a test marker', async ({ page, bench, withKeys }) => {
		test.skip(!LIVE_MODE, 'recorded mode serves marked bodies on purpose — run pnpm qa:live for this one');

		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);

		// Only bodies that genuinely came off the network. The metered providers are answered
		// from a recording even here, so including them would just find the bench's own marks.
		const live = bench.liveBodies();
		expect(live.length, 'no provider answered over the real network, so this proves nothing').toBeGreaterThan(0);

		const leaked = live
			.map((body) => ({ body, hits: findTestMarkers(body.text) }))
			.filter((entry) => entry.hits.length > 0);

		expect(
			leaked.map((entry) => entry.body.url),
			leaked
				.map((entry) => `${entry.body.providerId ?? 'unknown'} answered ${entry.body.url} with:\n${describeMarkerHits(entry.hits)}`)
				.join('\n\n') + '\n\nA recorded response reached the path a real answer travels.'
		).toEqual([]);
	});

	test('every recorded response is marked, so the live check has something to find', async ({
		page,
		bench,
		withKeys
	}) => {
		test.skip(LIVE_MODE, 'live providers answer with real data, which is unmarked by definition');

		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);

		expect(bench.bodies.length, 'no provider was called, so this proves nothing').toBeGreaterThan(0);

		// Not every body has a human-readable field to stamp — a route list is airport codes
		// and nothing else. What must hold is that the marking reaches the bodies that carry
		// names, which is every body a fabricated price could hide in.
		const marked = bench.bodies.filter((body) => hasTestMarker(body.text));
		expect(
			marked.length,
			`Not one of the ${bench.bodies.length} recorded bodies served in this run carries a marker from tests/e2e/fixtures/markers.json. The stamping in tests/qa/support/responses.ts has stopped working, which would leave pnpm qa:live checking nothing.`
		).toBeGreaterThan(0);
	});
});
