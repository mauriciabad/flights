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
 * `insertStable` lets a newly-arrived result land above an existing one when it genuinely
 * sorts better. Issue #314 measured what that costs a reader on a phone and added
 * `insertWithoutDisplacing` below, which is what the streaming page uses now.
 * `insertStable` is still the right tool for a merge the traveller asked for, where the
 * list is expected to reorder.
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

/**
 * Where a newly-arrived result can go without moving a card the traveller can see.
 *
 * Issue #314 measured what the paragraph at the top of this file calls "sort by score doing
 * its job". On `BCN -> PFO` it happened three times in one run, and each time the card
 * filling a 375px phone screen was pushed a full card height out of view: 0.40 of layout
 * shift apiece, 1.2 of the page's 1.36, and the reader loses the trip they were reading.
 * Reserving space cannot help with it. The space was reserved and the card still moved,
 * because the thing that moved it was a card inserted above it, not a card appended below.
 *
 * So the arrival goes to its sorted place when the card it would push down is off screen, and
 * to the end of the list when it is not. `isOffScreen` is asked about the card currently
 * sitting at the insertion point, and the page answers it by measuring, because only the page
 * knows where anything is. Appending is the issue's own suggestion, and it costs nothing: the
 * end of the list is below the fold by the time there is anything in it.
 *
 * The result still arrives on screen the moment the provider answers it. Two earlier rules
 * did not, and both were wrong in the same way. Refusing to place it at all held five of the
 * owner's six results, because every arrival on that route scores better than the one before
 * it, and a list that stops growing keeps its one card on screen forever. Refusing only when
 * the *last placed* card would move held the same five. Both are batching with extra steps,
 * against a brief that says a card appearing every two seconds is the app being honest about
 * progress.
 *
 * What is deferred is the reordering, not the trip: `sortedIntoPlace: false` says this one is
 * sitting at the end rather than where the sort control claims it should be. A card three
 * screens down can be displaced all day, so most arrivals come back `true` and land exactly
 * where they belong.
 *
 * The page does not read that flag to decide what to offer. It compares the rendered list
 * against the sort instead, because a card the traveller has refined carries its new price
 * outside this module altogether and an append is only one of the two ways a list gets out
 * of order. The flag stays as this function's own record of which branch it took.
 *
 * A repeat id never moves. It is a fresher read of a card already on screen (a price
 * revalidating, a bed arriving) and it updates in place.
 */
export function insertWithoutDisplacing(
	order: readonly StreamSlot[],
	incoming: StreamSlot,
	compare: ResultComparator,
	isOffScreen: (displaced: StreamSlot) => boolean
): { order: StreamSlot[]; sortedIntoPlace: boolean } {
	const existingIndex = order.findIndex((slot) => slot.id === incoming.id);
	if (existingIndex !== -1) {
		const next = order.slice();
		next[existingIndex] = incoming;
		return { order: next, sortedIntoPlace: true };
	}

	let insertAt = order.length;
	for (let i = 0; i < order.length; i++) {
		if (compare(incoming.result, order[i].result) < 0) {
			insertAt = i;
			break;
		}
	}

	const next = order.slice();
	// Appending displaces nobody, whatever is on screen, so the question is only worth asking
	// when the sorted position is somewhere else.
	if (insertAt < order.length && !isOffScreen(order[insertAt])) {
		next.push(incoming);
		return { order: next, sortedIntoPlace: false };
	}

	next.splice(insertAt, 0, incoming);
	return { order: next, sortedIntoPlace: true };
}

/**
 * Reorders a standing order by scores measured somewhere else.
 *
 * `shown[i]` is the result `order[i]` is currently rendering, which is not always the result
 * the slot holds: the page re-derives a card the traveller has lengthened, and deliberately
 * does not write that back (an effect reading and writing one piece of state is what froze
 * this page once). Sorting the slots on their own scores therefore sorts by prices nobody is
 * looking at, and put a EUR 185.58 stopover back under the EUR 88.53 the stream had
 * delivered.
 *
 * Paired by index rather than by id, so no card can go missing if the two lists ever stop
 * agreeing about names, and the slots themselves are carried over so each card keeps the
 * result it was holding and only its position moves. For an explicit re-sort, so a full sort
 * is the point rather than a jump; `insertWithoutDisplacing` is what streaming arrivals use.
 */
export function reorderBy(
	order: readonly StreamSlot[],
	shown: readonly ScoredResult[],
	compare: ResultComparator
): StreamSlot[] {
	return order
		.map((slot, index) => ({ slot, shown: shown[index] ?? slot.result }))
		.sort((a, b) => compare(a.shown, b.shown))
		.map((pair) => pair.slot);
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
