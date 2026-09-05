import { describe, expect, it } from 'vitest';
import { compareResults, sortResults } from './sort';
import { insertStable, insertWithoutDisplacing, slotsToResults, toSlot } from './stream-order';
import { makeScoredResult } from './test-support';

const byScore = compareResults('score');

describe('insertStable', () => {
	it('inserts a new result at its sorted position among existing ones', () => {
		const low = makeScoredResult({ priceMinorUnits: 30_000, nightsInConnection: 0 }); // worst score
		const high = makeScoredResult({ priceMinorUnits: 6_000, nightsInConnection: 3 }); // best score
		const mid = makeScoredResult({ priceMinorUnits: 12_000, nightsInConnection: 1 });

		let order = insertStable([], toSlot(high), byScore);
		order = insertStable(order, toSlot(low), byScore);
		order = insertStable(order, toSlot(mid), byScore);

		expect(slotsToResults(order).map((r) => r.id)).toEqual([high.id, mid.id, low.id]);
	});

	it('never swaps two results that have both already been placed', () => {
		// Placed in the "wrong" order relative to score on purpose, once both are in the
		// standing order, insertStable must never reconcile that by swapping them; only a
		// fresh call to `sortResults` (an explicit user action) does that.
		const worse = makeScoredResult({ priceMinorUnits: 30_000 });
		const better = makeScoredResult({ priceMinorUnits: 5_000 });

		let order = insertStable([], toSlot(worse), byScore);
		order = insertStable(order, toSlot(better), byScore);
		const firstOrder = slotsToResults(order).map((r) => r.id);

		// A third, middling result arrives. It may land between the two, but worse/better
		// must keep their existing relative order.
		const middling = makeScoredResult({ priceMinorUnits: 15_000 });
		order = insertStable(order, toSlot(middling), byScore);
		const secondOrder = slotsToResults(order).map((r) => r.id);

		expect(firstOrder.indexOf(worse.id)).toBeGreaterThan(firstOrder.indexOf(better.id));
		expect(secondOrder.indexOf(worse.id)).toBeGreaterThan(secondOrder.indexOf(better.id));
	});

	it('updates an existing id in place without moving its position', () => {
		const a = makeScoredResult({ priceMinorUnits: 10_000 });
		const b = makeScoredResult({ priceMinorUnits: 20_000 });
		let order = insertStable([], toSlot(a), byScore);
		order = insertStable(order, toSlot(b), byScore);
		const positionBefore = order.findIndex((slot) => slot.id === a.id);

		// Simulate a's price revalidating to something that would now score much better.
		// If this module resorted, `a` would move; it must not.
		const revalidatedA = { ...a, score: { ...a.score, total: a.score.total + 1000 } };
		order = insertStable(order, toSlot(revalidatedA), byScore);
		const positionAfter = order.findIndex((slot) => slot.id === a.id);

		expect(positionAfter).toBe(positionBefore);
		expect(order[positionAfter]?.result.score.total).toBe(revalidatedA.score.total);
	});

	it('breaks ties on arrival sequence, deterministically regardless of arrival order', () => {
		const first = makeScoredResult({ priceMinorUnits: 10_000, sequence: 1 });
		const second = makeScoredResult({ priceMinorUnits: 10_000, sequence: 2 });
		// Same price, same nights => equal score. Whichever arrives, the earlier sequence
		// must end up first once both are in.
		let order = insertStable([], toSlot(second), byScore);
		order = insertStable(order, toSlot(first), byScore);

		expect(slotsToResults(order).map((r) => r.id)).toEqual([first.id, second.id]);
	});
});

describe('insertWithoutDisplacing', () => {
	/** Nothing is on screen, so nothing can be displaced. */
	const allOffScreen = () => true;
	/** Every card is under the traveller's eyes, the state a phone is in with one card. */
	const allOnScreen = () => false;

	it('places a result at its sorted position when the card it pushes down is off screen', () => {
		const better = makeScoredResult({ priceMinorUnits: 6_000, nightsInConnection: 3 });
		const worse = makeScoredResult({ priceMinorUnits: 30_000, nightsInConnection: 0 });

		const first = insertWithoutDisplacing([], toSlot(worse), byScore, allOffScreen);
		const second = insertWithoutDisplacing(first.order, toSlot(better), byScore, allOffScreen);

		expect(second.sortedIntoPlace).toBe(true);
		expect(slotsToResults(second.order).map((r) => r.id)).toEqual([better.id, worse.id]);
	});

	it('sends a result that would push a visible card down to the end of the list instead', () => {
		const placed = makeScoredResult({ priceMinorUnits: 30_000, nightsInConnection: 0 });
		const better = makeScoredResult({ priceMinorUnits: 6_000, nightsInConnection: 3 });

		const { order } = insertWithoutDisplacing([], toSlot(placed), byScore, allOnScreen);
		const appended = insertWithoutDisplacing(order, toSlot(better), byScore, allOnScreen);

		// On screen, so the traveller sees it stream in, and last, so nothing already on
		// screen moved to make room. What waits is the reordering.
		expect(appended.sortedIntoPlace).toBe(false);
		expect(slotsToResults(appended.order).map((r) => r.id)).toEqual([placed.id, better.id]);
	});

	it('appends without asking, because appending displaces nobody', () => {
		// The predicate would refuse everything, and this still goes in: it lands after the
		// last card rather than on top of one.
		const better = makeScoredResult({ priceMinorUnits: 6_000, nightsInConnection: 3 });
		const worse = makeScoredResult({ priceMinorUnits: 30_000, nightsInConnection: 0 });

		const { order } = insertWithoutDisplacing([], toSlot(better), byScore, allOnScreen);
		const appended = insertWithoutDisplacing(order, toSlot(worse), byScore, allOnScreen);

		expect(appended.sortedIntoPlace).toBe(true);
		expect(slotsToResults(appended.order).map((r) => r.id)).toEqual([better.id, worse.id]);
	});

	it('only asks about the one card it would displace', () => {
		// The card at the insertion point, not every card in the list. This is what stopped the
		// owner's own route holding five results of six: a trip that sorts fourth pushes the
		// fourth card down, and on a phone nobody is looking at the fourth card.
		const best = makeScoredResult({ priceMinorUnits: 5_000, nightsInConnection: 3 });
		const middling = makeScoredResult({ priceMinorUnits: 15_000, nightsInConnection: 1 });
		const worst = makeScoredResult({ priceMinorUnits: 30_000, nightsInConnection: 0 });

		let order = insertWithoutDisplacing([], toSlot(best), byScore, allOffScreen).order;
		order = insertWithoutDisplacing(order, toSlot(worst), byScore, allOffScreen).order;

		const asked: string[] = [];
		const result = insertWithoutDisplacing(order, toSlot(middling), byScore, (displaced) => {
			asked.push(displaced.id);
			return true;
		});

		expect(asked).toEqual([worst.id]);
		expect(slotsToResults(result.order).map((r) => r.id)).toEqual([best.id, middling.id, worst.id]);
	});

	it('places the first result whatever it scores, because it displaces nobody', () => {
		const anything = makeScoredResult({ priceMinorUnits: 6_000, nightsInConnection: 3 });

		const { order, sortedIntoPlace } = insertWithoutDisplacing(
			[],
			toSlot(anything),
			byScore,
			allOnScreen
		);

		expect(sortedIntoPlace).toBe(true);
		expect(slotsToResults(order).map((r) => r.id)).toEqual([anything.id]);
	});

	it('updates a card already on screen in place, and never holds it', () => {
		// Issue #293's revalidation arrives as a repeat id carrying a better price. Holding it
		// would leave the traveller reading the stale number with a "1 better trip" offer
		// beside it that is the same trip.
		const a = makeScoredResult({ priceMinorUnits: 30_000 });
		const b = makeScoredResult({ priceMinorUnits: 40_000 });
		let order = insertWithoutDisplacing([], toSlot(a), byScore, allOnScreen).order;
		order = insertWithoutDisplacing(order, toSlot(b), byScore, allOnScreen).order;

		const fresher = { ...b, score: { ...b.score, total: b.score.total + 1000 } };
		const result = insertWithoutDisplacing(order, toSlot(fresher), byScore, allOnScreen);

		expect(result.sortedIntoPlace).toBe(true);
		expect(slotsToResults(result.order).map((r) => r.id)).toEqual([a.id, b.id]);
		expect(result.order[1]?.result.score.total).toBe(fresher.score.total);
	});

	it('leaves the given order untouched, so a Svelte assignment sees a new array', () => {
		const placed = makeScoredResult({ priceMinorUnits: 30_000, nightsInConnection: 0 });
		const better = makeScoredResult({ priceMinorUnits: 6_000, nightsInConnection: 3 });
		const order = insertWithoutDisplacing([], toSlot(placed), byScore, allOnScreen).order;

		const held = insertWithoutDisplacing(order, toSlot(better), byScore, allOnScreen);

		expect(held.order).not.toBe(order);
		expect(order).toHaveLength(1);
	});

	it('puts an appended arrival in its place once the traveller asks for a sort', () => {
		// What the "sort N trips into place" control does. `sortResults` rather than
		// `insertStable`, because a re-sort somebody asked for is meant to reorder.
		const worse = makeScoredResult({ priceMinorUnits: 30_000, nightsInConnection: 0 });
		const better = makeScoredResult({ priceMinorUnits: 6_000, nightsInConnection: 3 });
		let order = insertWithoutDisplacing([], toSlot(worse), byScore, allOnScreen).order;
		order = insertWithoutDisplacing(order, toSlot(better), byScore, allOnScreen).order;

		const sorted = sortResults(slotsToResults(order), 'score');

		expect(sorted.map((r) => r.id)).toEqual([better.id, worse.id]);
	});
});
