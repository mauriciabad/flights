/**
 * Issue #23: "Sort by score by default, with price and duration as alternatives."
 *
 * Every comparator ends in the same tie-break, arrival `sequence`, so that two results
 * this module considers equal always resolve in the same order regardless of which JS
 * engine's sort implementation runs, and so `stream-order.ts`'s insertion point for a new
 * arrival is deterministic rather than "wherever this engine's sort happened to leave it."
 */

import type { ScoredResult } from './types';

export const SORT_MODES = ['score', 'price', 'duration'] as const;
export type SortMode = (typeof SORT_MODES)[number];

export const SORT_MODE_LABELS: Record<SortMode, string> = {
	score: 'Best match',
	price: 'Cheapest',
	duration: 'Fastest'
};

function bySequence(a: ScoredResult, b: ScoredResult): number {
	return a.sequence - b.sequence;
}

/**
 * Higher score is better, so this sorts descending; price and duration sort ascending
 * (cheapest/fastest first). Comparing `totalPrice.minorUnits` directly is safe on the
 * same assumption `algorithm/score.ts` already documents: one search shares one currency,
 * so this is never comparing, say, cents to yen.
 */
export function compareResults(mode: SortMode): (a: ScoredResult, b: ScoredResult) => number {
	switch (mode) {
		case 'score':
			return (a, b) => b.score.total - a.score.total || bySequence(a, b);
		case 'price':
			return (a, b) =>
				a.itinerary.totalPrice.minorUnits - b.itinerary.totalPrice.minorUnits || bySequence(a, b);
		case 'duration':
			return (a, b) => a.itinerary.times.total - b.itinerary.times.total || bySequence(a, b);
	}
}

/** For an explicit, user-triggered re-sort (changing the sort mode), not for merging
 * streamed arrivals, where `stream-order.ts`'s `insertStable` is the right tool so
 * already-placed cards don't reorder relative to each other. Switching sort mode is a
 * deliberate action, so a full, fresh sort here is expected, not "the list jumping." */
export function sortResults(results: readonly ScoredResult[], mode: SortMode): ScoredResult[] {
	return results.slice().sort(compareResults(mode));
}
