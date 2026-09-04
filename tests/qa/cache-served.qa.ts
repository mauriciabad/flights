/**
 * Invariant: a cached answer is served, not discarded.
 *
 * AGENTS.md, rule three: "Stale first, then fresh. Show the cached answer immediately,
 * refetch anyway, update in place. The owner asked for this by name."
 *
 * `src/lib/cache/` implements exactly that, in three tiers, with `ExpiredFallbackResult`
 * carrying an `ageMs` for the label. Every cache-aside reader in `providers/` reimplemented
 * the same three lines instead, and every one chose to discard: `ryanair.ts`'s `readCache`
 * read the entry, saw it was past its 5-minute TTL, and returned `undefined` — losing an
 * answer it was holding in its hand. Fixed for fares by #155; the other readers still do it,
 * which is why this check is written about the behaviour rather than about that function.
 *
 * ## How this is measured
 *
 * Every provider response is held back by `SLOW_MS` before the reload. Anything on screen
 * before that has elapsed cannot have come from the network, so a stopwatch is enough to
 * tell a cache hit from a cold search, with no reach into the app's internals.
 *
 * The within-TTL case runs first, and it is the control: it proves the delay works and that
 * a reload can paint from cache at all, so when the past-TTL case fails the failure is about
 * the TTL and not about the method.
 *
 * The control is what caught #194. It passed against `origin/main` at 49bd622, painting in
 * 2.0s, and stopped passing the moment PR #174 merged — three sequential `OnePerCity`
 * lookups now go out on a reload where nothing has expired, and nothing paints until they
 * are done. Both checks in this file are pinned to that, because they measure the same paint
 * one TTL apart and the same thing is holding it.
 */

import { test, expect } from './support/bench';
import { knownBroken } from './known-broken';
import { resultsUrl } from './support/scenario';
import { provenanceLines, resultCards, waitForSearchToFinish } from './support/page';

/** Long enough that no network answer can arrive inside the window a cache hit has to paint
 * in, short enough that a genuinely cold reload still finishes before the test times out. */
const SLOW_MS = 8_000;
const CACHE_HIT_MS = 4_000;

/** `ryanair.ts`'s `FARES_TTL_MS` is 5 minutes. Half an hour is past it by any reading. */
const PAST_THE_FARE_TTL = '30:00';

async function firstCardArrivesWithin(page: import('@playwright/test').Page, ms: number): Promise<boolean> {
	try {
		await resultCards(page).first().waitFor({ state: 'visible', timeout: ms });
		return true;
	} catch {
		return false;
	}
}

test.describe('cached answers are served, not discarded', () => {
	test('a reload inside the TTL paints from cache before the network answers', async ({ page, bench }) => {
		knownBroken('reload-waits-for-kiwi');

		await page.clock.install({ time: new Date('2026-09-20T09:00:00Z') });
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);
		expect(await resultCards(page).count(), 'the first search found nothing to cache').toBeGreaterThan(0);

		bench.resetLog();
		bench.delayResponsesBy(SLOW_MS);
		await page.goto(resultsUrl());

		const painted = await firstCardArrivesWithin(page, CACHE_HIT_MS);
		expect(
			painted,
			[
				`A reload one minute after a search showed nothing for ${CACHE_HIT_MS}ms while every provider response was held back by ${SLOW_MS}ms.`,
				'Nothing has expired at this point, so every answer the page needs is already in',
				'IndexedDB. What went back to the network for it anyway:',
				bench.describeTraffic(),
				'',
				'One adapter awaiting one request is enough to hold the whole page blank, because',
				'the candidate graph waits on all of them. If this fails, the past-TTL measurement',
				'below cannot be trusted either: it is the same paint, one TTL later.'
			].join('\n')
		).toBe(true);
	});

	test('a reload past the fare TTL still shows the previous answer, with its age', async ({ page, bench }) => {
		knownBroken('reload-waits-for-kiwi');

		await page.clock.install({ time: new Date('2026-09-20T09:00:00Z') });
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);
		const before = await resultCards(page).count();
		expect(before, 'the first search found nothing to cache').toBeGreaterThan(0);

		await page.clock.fastForward(PAST_THE_FARE_TTL);
		bench.resetLog();
		bench.delayResponsesBy(SLOW_MS);
		await page.goto(resultsUrl());

		const painted = await firstCardArrivesWithin(page, CACHE_HIT_MS);
		expect(
			painted,
			[
				`Half an hour after a search, a reload showed nothing for ${CACHE_HIT_MS}ms while every provider was held back by ${SLOW_MS}ms.`,
				'The previous answer is still in IndexedDB. What went back to the network for it:',
				bench.describeTraffic(),
				'',
				'Past its TTL an entry is stale, not absent. src/lib/cache/ has modelled that as a',
				'third tier with an ageMs on it all along. Every cache-aside reader in providers/',
				'that collapses expired and absent into the same undefined leaves its caller unable',
				'to tell them apart, and one of them doing it is enough to stop the page painting.'
			].join('\n')
		).toBe(true);

		// A stale answer shown as if it were current is its own defect: the traveller books a
		// price nobody is selling. The card's own footer is where the age has to appear.
		const lines = await provenanceLines(page);
		const claimingFresh = lines.filter((line) => /this minute|just now/i.test(line));
		expect(
			claimingFresh,
			`After a 30-minute jump, ${claimingFresh.length} card(s) still describe their numbers as fetched this minute: ${claimingFresh.join(' | ')}. A cache hit must report the age of what it is showing, not the age of the read.`
		).toEqual([]);
	});
});
