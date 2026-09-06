import { describe, expect, it } from 'vitest';
import { compareResults, outOfSortedPlace, sortResults } from './sort';
import { makeScoredResult } from './test-support';

describe('sortResults', () => {
	it('sorts by score descending (best match first) by default', () => {
		const cheapNoNights = makeScoredResult({ priceMinorUnits: 8_000, nightsInConnection: 0, sequence: 1 });
		const pricierWithNights = makeScoredResult({ priceMinorUnits: 8_800, nightsInConnection: 3, sequence: 2 });

		const sorted = sortResults([cheapNoNights, pricierWithNights], 'score');

		// The product thesis (docs/prompts/001-initial-brief.md): a few extra euros for a
		// real stopover should outrank a marginally cheaper quick connection.
		expect(sorted[0]?.id).toBe(pricierWithNights.id);
	});

	it('sorts by price ascending regardless of score', () => {
		const cheap = makeScoredResult({ priceMinorUnits: 5_000, nightsInConnection: 0, sequence: 1 });
		const expensiveWithNights = makeScoredResult({ priceMinorUnits: 50_000, nightsInConnection: 5, sequence: 2 });

		const sorted = sortResults([expensiveWithNights, cheap], 'price');

		expect(sorted.map((r) => r.id)).toEqual([cheap.id, expensiveWithNights.id]);
	});

	it('sorts by total duration ascending', () => {
		const slower = makeScoredResult({ totalMinutes: 900, sequence: 1 });
		const faster = makeScoredResult({ totalMinutes: 400, sequence: 2 });

		const sorted = sortResults([slower, faster], 'duration');

		expect(sorted.map((r) => r.id)).toEqual([faster.id, slower.id]);
	});

	it('breaks exact ties on arrival sequence, never leaving the order to chance', () => {
		const first = makeScoredResult({ priceMinorUnits: 9_000, sequence: 5 });
		const second = makeScoredResult({ priceMinorUnits: 9_000, sequence: 6 });

		const sorted = sortResults([second, first], 'price');

		expect(sorted.map((r) => r.id)).toEqual([first.id, second.id]);
	});

	it('does not mutate the input array', () => {
		const a = makeScoredResult({ priceMinorUnits: 10_000 });
		const b = makeScoredResult({ priceMinorUnits: 5_000 });
		const input = [a, b];

		sortResults(input, 'price');

		expect(input).toEqual([a, b]);
	});

	it('compareResults exposes the same ordering sortResults uses', () => {
		const a = makeScoredResult({ priceMinorUnits: 10_000 });
		const b = makeScoredResult({ priceMinorUnits: 5_000 });

		expect(compareResults('price')(a, b)).toBeGreaterThan(0);
	});
});

describe('outOfSortedPlace', () => {
	it('names nothing when the list already agrees with the sort', () => {
		const cheap = makeScoredResult({ priceMinorUnits: 5_000, sequence: 1 });
		const dear = makeScoredResult({ priceMinorUnits: 50_000, sequence: 2 });

		expect(outOfSortedPlace([cheap, dear], 'price')).toEqual([]);
	});

	it('names a card whose price moved after it was placed', () => {
		// Production, BCN to PFO sorted by "Cheapest": lengthening the Sofia stopover from two
		// nights to six took that card from EUR 88.53 to EUR 185.58 and left it sitting above a
		// EUR 108.16 trip. Nothing watching arrivals can see this, because the new price never
		// reaches the standing order.
		const cheapest = makeScoredResult({ priceMinorUnits: 4_251, sequence: 1 });
		const lengthened = makeScoredResult({ priceMinorUnits: 18_558, sequence: 2 });
		const middling = makeScoredResult({ priceMinorUnits: 10_816, sequence: 3 });

		const named = outOfSortedPlace([cheapest, lengthened, middling], 'price');

		// Both of them, because both change slot when the traveller asks for a sort. Naming
		// only the one they touched would promise to move one card and move two.
		expect(named.map((result) => result.id)).toEqual([lengthened.id, middling.id]);
	});

	it('stops naming a card once the list is put right', () => {
		const cheapest = makeScoredResult({ priceMinorUnits: 4_251, sequence: 1 });
		const lengthened = makeScoredResult({ priceMinorUnits: 18_558, sequence: 2 });
		const middling = makeScoredResult({ priceMinorUnits: 10_816, sequence: 3 });

		const sorted = sortResults([cheapest, lengthened, middling], 'price');

		expect(outOfSortedPlace(sorted, 'price')).toEqual([]);
	});

	it('answers for the mode it is asked about, not for the default one', () => {
		// Cheapest and best-match disagree by design: the product thesis pays a few euros for
		// a real stopover. A list in score order is out of place as a price list and vice
		// versa, and the control must not offer to "fix" a list that is already right.
		const cheapNoNights = makeScoredResult({ priceMinorUnits: 8_000, nightsInConnection: 0, sequence: 1 });
		const pricierWithNights = makeScoredResult({ priceMinorUnits: 8_800, nightsInConnection: 3, sequence: 2 });
		const byScore = sortResults([cheapNoNights, pricierWithNights], 'score');

		expect(outOfSortedPlace(byScore, 'score')).toEqual([]);
		expect(outOfSortedPlace(byScore, 'price')).toHaveLength(2);
	});
});
