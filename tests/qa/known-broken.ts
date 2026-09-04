/**
 * The invariants this app breaks today, each pinned to the open issue that owns the fix.
 *
 * Every check in `tests/qa/` is written against the app as it should behave, not as it does.
 * Rather than soften a check until it passes, or leave CI permanently red and therefore
 * permanently ignored, a check that fails because the app is broken is marked
 * expected-to-fail here, against the issue that owns the fix.
 *
 * All four of the defects this suite was written for failed here when it was written. Three
 * were fixed while it was in review (#154, #155, #156) and their entries are gone, which is
 * how this file is meant to shrink. The ones left are #146, #158 and #165 — #165 being the same two defects arriving again in a
 * provider added after they were fixed, which is what this suite is for.
 *
 * The mark is a ratchet, not an excuse. Playwright fails the run when an expected-to-fail
 * test PASSES, so the moment somebody fixes #146 the QA suite goes red until they come
 * back to this file and delete the entry. A defect cannot be fixed and quietly
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
	'kiwi-fan-out': {
		issue: 165,
		summary: 'kiwi-public sends 46 requests in one search, four times what Ryanair spends on the same question',
		observed: 'no per-search ceiling exists for flight providers the way StayLookupBudget is one for stays'
	},
	'kiwi-discards-expired': {
		issue: 165,
		summary: 'kiwi-public throws away an expired cache entry, so a reload is a cold search again',
		observed:
			'kiwi-public.ts:205 is the line #155 removed from ryanair.ts, in an adapter merged after it; the candidate graph waits on Kiwi, so one adapter discarding undoes stale-first for the page'
	},
	'stay-never-priced': {
		issue: 158,
		summary: 'Every itinerary still reads "No bed priced for this stopover"',
		observed:
			'+page.svelte deps() names no currency, so Agoda is called without currency_id, answers USD, and build.ts drops a stay it cannot total against EUR flights'
	},
	'quota-from-headers': {
		issue: 146,
		summary: 'The quota shown is a per-browser localStorage tally, not what the key spent',
		observed:
			'no client reads x-ratelimit-* on a successful response; the settings card shows cap minus a local counter'
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
