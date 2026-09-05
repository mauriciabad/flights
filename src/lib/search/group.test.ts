import { describe, expect, it } from 'vitest';
import { scoreItinerary } from '../algorithm/score';
import { makeItinerary } from '../results/test-support';
import { groupItineraryResults } from './group';
import type { ItineraryResult, ItinerarySources } from './types';
import type { ProviderId } from '../providers/types';

const SOURCES: ItinerarySources = {
	outboundFlight: { providerId: 'ryanair' as ProviderId, fetchedAt: '2026-10-06T00:00:00.000Z' },
	onwardFlight: { providerId: 'ryanair' as ProviderId, fetchedAt: '2026-10-06T00:00:00.000Z' }
};

function variant(options: {
	connectionAirportCode?: string;
	nights: number;
	priceMinorUnits?: number;
}): ItineraryResult {
	const itinerary = makeItinerary({
		connectionAirportCode: options.connectionAirportCode ?? 'LGW',
		nightsInConnection: options.nights,
		priceMinorUnits: options.priceMinorUnits
	});
	return { score: scoreItinerary(itinerary), sources: SOURCES };
}

describe('groupItineraryResults', () => {
	it('opens each stopover at its shortest length when price cannot separate them, not its best-scoring one', () => {
		// The measured defect, issue #224: BVC->PFO over 6 to 12 October returned six
		// nights in London, because `score.ts` pays 40 points for the first night and 75%
		// of the previous one for each after, so the widest pairing always topped its own
		// group. The one-night trip was in `variants` the whole time.
		const groups = groupItineraryResults([
			variant({ nights: 6 }),
			variant({ nights: 3 }),
			variant({ nights: 1 })
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.best.score.itinerary.nightsInConnection).toBe(1);
	});

	it('keeps every longer pairing in variants, for the card’s nights control to reach', () => {
		const groups = groupItineraryResults([variant({ nights: 6 }), variant({ nights: 1 })]);

		expect(
			groups[0]?.variants.map((result) => result.score.itinerary.nightsInConnection).sort()
		).toEqual([1, 6]);
	});

	it('picks the best-scoring pairing among those of the chosen length', () => {
		// Two one-night pairings differ only in fares and times; the length rule decides the
		// length and `score.ts` still decides which trip at that length. The four-night
		// pairing is priced well clear of both so it cannot win the length itself, which is
		// the next test's job rather than this one's.
		const groups = groupItineraryResults([
			variant({ nights: 1, priceMinorUnits: 40_000 }),
			variant({ nights: 1, priceMinorUnits: 20_000 }),
			variant({ nights: 4, priceMinorUnits: 60_000 })
		]);

		expect(groups[0]?.best.score.itinerary.totalPrice.minorUnits).toBe(20_000);
	});

	it('opens on a longer stay when it is the cheaper trip, which is issue #364', () => {
		// The owner's own card, in cents. BCN to BVC via Porto opened same-day at EUR 424.00
		// with the one-night pairing at EUR 237.78 in the same `variants` array, and the app
		// printed the EUR 186.22 saving under the trip it had already chosen against.
		const groups = groupItineraryResults([
			variant({ nights: 0, priceMinorUnits: 42_400 }),
			variant({ nights: 1, priceMinorUnits: 23_778 })
		]);

		expect(groups[0]?.best.score.itinerary.nightsInConnection).toBe(1);
	});

	it('still opens on the shorter stay when the longer one costs more', () => {
		// Issue #230's London card, which the cheapest rule has to keep answering the same
		// way: six nights at EUR 307.00 against one at EUR 265.00.
		const groups = groupItineraryResults([
			variant({ nights: 6, priceMinorUnits: 30_700 }),
			variant({ nights: 1, priceMinorUnits: 26_500 })
		]);

		expect(groups[0]?.best.score.itinerary.nightsInConnection).toBe(1);
	});

	it('opens on the same-day pairing when a city can be flown through in a day at the same price', () => {
		// Issue #225: "there shoudl be no casa in wich the nights could be 0 or more, that
		// case should just be a flight change and thats it."
		const groups = groupItineraryResults([variant({ nights: 2 }), variant({ nights: 0 })]);

		expect(groups[0]?.best.score.itinerary.nightsInConnection).toBe(0);
	});

	it('ranks cities against each other at the length their cards show', () => {
		// The comparison bug the issue names: ranking on the longest pairing compared
		// stopover lengths as much as prices. Rome at one night for EUR 200 is a better
		// card than London at one night for EUR 260, whatever London's six-night variant
		// scores.
		const groups = groupItineraryResults([
			variant({ connectionAirportCode: 'LGW', nights: 1, priceMinorUnits: 26_000 }),
			variant({ connectionAirportCode: 'LGW', nights: 6, priceMinorUnits: 30_000 }),
			variant({ connectionAirportCode: 'FCO', nights: 1, priceMinorUnits: 20_000 })
		]);

		expect(groups.map((group) => group.connectionAirportCode)).toEqual(['FCO', 'LGW']);
	});

	it('still sorts each group’s variants best score first, for the flight pickers', () => {
		const groups = groupItineraryResults([
			variant({ nights: 1, priceMinorUnits: 40_000 }),
			variant({ nights: 1, priceMinorUnits: 20_000 })
		]);

		const totals = groups[0]?.variants.map((result) => result.score.total) ?? [];
		expect(totals[0]).toBeGreaterThan(totals[1] as number);
	});
});
