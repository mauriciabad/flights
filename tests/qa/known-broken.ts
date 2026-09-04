/**
 * The invariants this app breaks today, each pinned to the open issue that owns the fix.
 *
 * Every check in `tests/qa/` is written against the app as it should behave, not as it does.
 * Rather than soften a check until it passes, or leave CI permanently red and therefore
 * permanently ignored, a check that fails because the app is broken is marked
 * expected-to-fail here, against the issue that owns the fix.
 *
 * Every entry this suite was written with is now gone. #154, #155 and #156 landed while it
 * was in review; #146 and #158 landed in PRs #172 and #176, and #165 in PR #174, all three
 * during the rebase that made the suite measure anything at all. That is how this file is
 * meant to shrink.
 *
 * Both entries below are defects this suite found, which is the other half of what it is
 * for. Neither existed as an issue before a check failed on it.
 *
 * The mark is a promise that an issue exists and is open. Every entry below was checked
 * against the tracker on 2026-09-04. An entry whose issue has closed is worse than no
 * entry, because it hides a check nobody is running any more — #165 was pinned here for
 * about four hours after PR #174 closed it.
 *
 * The mark is also a one-way ratchet. Playwright fails the run when an expected-to-fail
 * test PASSES, so the moment somebody fixes one of these the QA suite goes red until they
 * come back to this file and delete the entry. A defect cannot be fixed and quietly
 * un-covered, and a new regression in the same area still fails the ordinary way.
 *
 * To un-pin: delete the entry, run `pnpm qa`, and it should be green.
 */

import { test } from './support/bench';

export interface PinnedDefect {
	issue: number;
	summary: string;
	/** What the check observes today, in the words a failure will print. */
	observed: string;
}

export const PINNED_DEFECTS: Readonly<Record<string, PinnedDefect>> = {
	'reload-waits-for-kiwi': {
		issue: 194,
		summary: 'A reload inside the TTL paints nothing while it waits on three sequential Kiwi lookups',
		observed:
			'nothing has expired and everything the page needs is in IndexedDB, yet three OnePerCity queries go out one after another and no card appears until they have; before PR #174 the same reload painted in 2.0s'
	},
	'stay-picker-crashes-the-detail': {
		issue: 188,
		summary: 'Opening a card with a priced bed throws each_key_duplicate and renders no detail panel at all',
		observed:
			'StayPicker.svelte:201 keys its alternatives on name plus coordinates, and groupByProperty hands it one group per stay rather than one per property, so a hotel with three room kinds produces three groups with the same key; the throw takes the timeline, the map and all four pickers with it'
	}
};

/**
 * Marks the current test expected-to-fail and says why, loudly enough that a reader of the
 * output learns the defect rather than just seeing a skip.
 *
 * Call it at the top of the test body, before the assertions — the assertions themselves
 * stay exactly as they would be written for a working app.
 */
export function knownBroken(key: keyof typeof PINNED_DEFECTS): void {
	const defect = PINNED_DEFECTS[key];

	// `QA_UNPIN=1` runs every check as if nothing were known broken, so the four failures
	// print their evidence in full instead of being swallowed as expected. That is how you
	// read what a pinned check is actually observing, and how you tell whether a fix has
	// landed before deleting its entry above. It can only ever make the run redder.
	if (process.env.QA_UNPIN === '1') return;

	test.fail(
		true,
		`KNOWN BROKEN — issue #${defect.issue}: ${defect.summary}. Today: ${defect.observed}. If this test now PASSES, the defect is fixed: delete the '${key}' entry from tests/qa/known-broken.ts.`
	);
}
