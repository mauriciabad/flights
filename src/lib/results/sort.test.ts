import { describe, expect, it } from 'vitest';
import { compareResults, sortResults } from './sort';
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
