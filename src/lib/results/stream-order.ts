/**
 * Issue #23's answer to "results stream in... the list must not jump around while it
 * fills, so reserve space and sort stably."
 *
 * A naive approach re-sorts the whole array on every incoming result. That is exactly
 * what makes a list "jump": two results already on screen can swap places relative to
 * EACH OTHER as soon as a comparator recomputes across the whole set, and a card the user
 * is reaching for slides out from under their finger. This module instead maintains a
 * standing order and only ever inserts into it or updates a slot's own content in place,
 * never re-sorts entries that are already both placed. That gives two guarantees a plain
 * `results.sort(compare)` cannot:
 *
 * 1. Two results that have both already been placed never swap order, no matter what
 *    arrives afterward or how either one's own score changes (e.g. a stale price
 *    revalidating to a different, fresher one).
 * 2. The same sequence of arrivals always produces the same order, because ties always
 *    break on `ScoredResult.sequence` (arrival order) rather than on comparison-sort
 *    implementation details.
 *
 * A newly-arrived result CAN still land above an existing one if it genuinely sorts
 * better, that is "sort by score" doing its job, not instability. What this module
 * forbids is two already-visible cards trading places.
 */

import type { ScoredResult } from './types';

export interface StreamSlot {
	id: string;
	result: ScoredResult;
}

export type ResultComparator = (a: ScoredResult, b: ScoredResult) => number;

/**
 * Inserts (or, for a repeat `id`, updates in place) one result into a standing order.
 * Pure: returns a new array, never mutates `order`, so a Svelte `$state` assignment
 * (`order = insertStable(order, incoming, compare)`) is exactly the reassignment runes
 * need to pick up the change.
 */
export function insertStable(
	order: readonly StreamSlot[],
	incoming: StreamSlot,
	compare: ResultComparator
): StreamSlot[] {
	const existingIndex = order.findIndex((slot) => slot.id === incoming.id);
	if (existingIndex !== -1) {
		// A repeat id is a fresher read of the same itinerary (e.g. its price finished
		// revalidating). Its content updates; its position, the whole point of this
		// module, does not.
		const next = order.slice();
		next[existingIndex] = incoming;
		return next;
	}

	let insertAt = order.length;
	for (let i = 0; i < order.length; i++) {
		if (compare(incoming.result, order[i].result) < 0) {
			insertAt = i;
			break;
		}
	}

	const next = order.slice();
	next.splice(insertAt, 0, incoming);
	return next;
}

/** `StreamSlot`, not `ScoredResult`, is this module's storage shape purely so `insertStable`
 * has an `id` to match on without reaching into `result.id` at every call site; everywhere
 * else just wants the results themselves. */
export function slotsToResults(order: readonly StreamSlot[]): ScoredResult[] {
	return order.map((slot) => slot.result);
}

export function toSlot(result: ScoredResult): StreamSlot {
	return { id: result.id, result };
}
