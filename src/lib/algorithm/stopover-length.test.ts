import { describe, expect, it } from 'vitest';
import {
	defaultStopover,
	defaultStopoverLength,
	isFlightChange,
	stopoverLengths,
	stopoverOfLength
} from './stopover-length';

/** A stand-in for whatever the caller is choosing between. `nights` is the only field
 * these functions read; `label` exists so a failing assertion names the pairing rather
 * than printing an object. */
interface Pairing {
	label: string;
	nights: number;
	/** What this pairing costs, in whatever unit the caller ranks in. Defaults to the same
	 * figure for every pairing in a case that is not about price, so those cases read as
	 * "nothing to choose between them but the length". */
	cost?: number;
}

const nightsOf = (pairing: Pairing) => pairing.nights;
const costOf = (pairing: Pairing) => pairing.cost ?? 0;

describe('stopoverLengths', () => {
	it('lists each distinct night count once, shortest first', () => {
		const lengths = stopoverLengths(
			[
				{ label: 'six', nights: 6 },
				{ label: 'three', nights: 3 },
				{ label: 'one', nights: 1 }
			],
			nightsOf
		);

		expect(lengths.map((length) => length.nights)).toEqual([1, 3, 6]);
	});

	it('keeps the first candidate at each length, so a best-first list yields that length’s best', () => {
		// `group.ts` and `pipeline.ts` both hand this a list already sorted best score
		// first. Two one-night pairings differ only in flight times, and the better-scoring
		// one is the one the card should open on.
		const lengths = stopoverLengths(
			[
				{ label: 'one-night-best', nights: 1 },
				{ label: 'one-night-worse', nights: 1 }
			],
			nightsOf
		);

		expect(lengths).toHaveLength(1);
		expect(lengths[0]?.pick.label).toBe('one-night-best');
		expect(lengths[0]?.count).toBe(2);
	});

	it('is empty for no candidates', () => {
		expect(stopoverLengths([], nightsOf)).toEqual([]);
	});
});

describe('defaultStopoverLength', () => {
	it('opens on the fewest nights when nothing separates the lengths on price, which is the whole of issue #224', () => {
		// The measured London card: the search window was 6 to 12 October and the widest
		// pairing swallowed all of it. The one-night trip was always in the same group.
		const lengths = stopoverLengths(
			[
				{ label: 'six', nights: 6 },
				{ label: 'three', nights: 3 },
				{ label: 'one', nights: 1 }
			],
			nightsOf
		);

		expect(defaultStopoverLength(lengths, costOf)?.pick.label).toBe('one');
	});

	it('opens on the same-day pairing when the city has one at the same price, rather than inventing a night', () => {
		// Issue #225: "there shoudl be no casa in wich the nights could be 0 or more, that
		// case should just be a flight change and thats it." Opening on the one-night
		// pairing here would be the app choosing a stopover the flights never forced.
		const lengths = stopoverLengths(
			[
				{ label: 'same-day', nights: 0 },
				{ label: 'one', nights: 1 }
			],
			nightsOf
		);

		expect(defaultStopoverLength(lengths, costOf)?.pick.label).toBe('same-day');
	});

	it('opens on a longer stay that costs less, which is issue #364', () => {
		// The owner's own card, in cents: BCN to BVC via Porto came back same-day at
		// EUR 424.00 with the one-night pairing at EUR 237.78 in the same group, and the app
		// recommended the same-day one and printed the EUR 186.22 saving underneath it.
		const lengths = stopoverLengths(
			[
				{ label: 'same-day', nights: 0, cost: 42400 },
				{ label: 'one', nights: 1, cost: 23778 },
				{ label: 'two', nights: 2, cost: 30358 },
				{ label: 'three', nights: 3, cost: 30138 }
			],
			nightsOf
		);

		expect(defaultStopoverLength(lengths, costOf)?.pick.label).toBe('one');
	});

	it('keeps the shorter stay when a longer one only matches its price', () => {
		// The boundary is "strictly cheaper", so a night that costs nothing extra still
		// costs a day and does not become the default.
		const lengths = stopoverLengths(
			[
				{ label: 'same-day', nights: 0, cost: 20000 },
				{ label: 'one', nights: 1, cost: 20000 }
			],
			nightsOf
		);

		expect(defaultStopoverLength(lengths, costOf)?.pick.label).toBe('same-day');
	});

	it('never opens on a longer stay that costs more, which is what issue #230 removed', () => {
		// The London card: six nights at EUR 307.00 against one at EUR 265.00. The rule that
		// replaces "shortest, full stop" has to keep giving this the same answer.
		const lengths = stopoverLengths(
			[
				{ label: 'one', nights: 1, cost: 26500 },
				{ label: 'six', nights: 6, cost: 30700 }
			],
			nightsOf
		);

		expect(defaultStopoverLength(lengths, costOf)?.pick.label).toBe('one');
	});

	it('is undefined for no lengths at all', () => {
		expect(defaultStopoverLength([], costOf)).toBeUndefined();
	});
});

describe('isFlightChange', () => {
	it('is true when the city can be flown through without a night', () => {
		expect(isFlightChange(stopoverLengths([{ label: 'a', nights: 0 }], nightsOf))).toBe(true);
	});

	it('stays true even when longer pairings exist through the same city', () => {
		// It describes the trip the card OPENS on, not whether a stopover is possible here.
		// The longer pairings are still on the ladder; what this decides is that none of
		// their nights is part of the price two cities get compared on.
		const lengths = stopoverLengths(
			[
				{ label: 'same-day', nights: 0 },
				{ label: 'two', nights: 2 }
			],
			nightsOf
		);

		expect(isFlightChange(lengths)).toBe(true);
	});

	it('is false once the shortest pairing spends a night', () => {
		const lengths = stopoverLengths(
			[
				{ label: 'one', nights: 1 },
				{ label: 'three', nights: 3 }
			],
			nightsOf
		);

		expect(isFlightChange(lengths)).toBe(false);
	});

	it('is false for an empty list, which is "nothing here" rather than "a connection"', () => {
		expect(isFlightChange([])).toBe(false);
	});
});

describe('stopoverOfLength', () => {
	const lengths = stopoverLengths(
		[
			{ label: 'one', nights: 1 },
			{ label: 'three', nights: 3 }
		],
		nightsOf
	);

	it('returns the pairing at exactly that many nights', () => {
		expect(stopoverOfLength(lengths, 3)?.pick.label).toBe('three');
	});

	it('returns undefined rather than the nearest, so nobody is silently given another trip', () => {
		expect(stopoverOfLength(lengths, 2)).toBeUndefined();
	});
});

describe('defaultStopover', () => {
	it('is the cheapest stopover’s own candidate', () => {
		expect(
			defaultStopover(
				[
					{ label: 'four', nights: 4, cost: 100 },
					{ label: 'two', nights: 2, cost: 300 }
				],
				nightsOf,
				costOf
			)?.label
		).toBe('four');
	});

	it('is the shortest when price cannot separate them', () => {
		expect(
			defaultStopover(
				[
					{ label: 'four', nights: 4 },
					{ label: 'two', nights: 2 }
				],
				nightsOf,
				costOf
			)?.label
		).toBe('two');
	});

	it('is undefined with nothing to choose from', () => {
		expect(defaultStopover([], nightsOf, costOf)).toBeUndefined();
	});
});
