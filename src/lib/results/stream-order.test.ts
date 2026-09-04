import { describe, expect, it } from 'vitest';
import { compareResults } from './sort';
import { insertStable, slotsToResults, toSlot } from './stream-order';
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
