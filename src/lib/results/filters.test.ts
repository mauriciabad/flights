import { describe, expect, it } from 'vitest';
import { applyFilters, deriveFilterOptions, emptyFilters, isEmptyFilters } from './filters';
import { makeScoredResult } from './test-support';

describe('emptyFilters / isEmptyFilters', () => {
	it('starts empty, hiding nothing', () => {
		expect(isEmptyFilters(emptyFilters())).toBe(true);
	});

	it('is not empty once any bound is set', () => {
		expect(isEmptyFilters({ ...emptyFilters(), maxPriceMinorUnits: 10_000 })).toBe(false);
	});
});

describe('applyFilters', () => {
	it('keeps everything when no filter is set', () => {
		const results = [makeScoredResult(), makeScoredResult()];
		expect(applyFilters(results, emptyFilters())).toHaveLength(2);
	});

	it('filters by max price', () => {
		const cheap = makeScoredResult({ priceMinorUnits: 5_000 });
		const pricey = makeScoredResult({ priceMinorUnits: 50_000 });

		const filtered = applyFilters([cheap, pricey], { ...emptyFilters(), maxPriceMinorUnits: 10_000 });

		expect(filtered.map((r) => r.id)).toEqual([cheap.id]);
	});

	it('filters by max total duration', () => {
		const fast = makeScoredResult({ totalMinutes: 300 });
		const slow = makeScoredResult({ totalMinutes: 3000 });

		const filtered = applyFilters([fast, slow], { ...emptyFilters(), maxTotalDurationMinutes: 600 });

		expect(filtered.map((r) => r.id)).toEqual([fast.id]);
	});

	it('filters by minimum nights', () => {
		const quick = makeScoredResult({ nightsInConnection: 0 });
		const longStopover = makeScoredResult({ nightsInConnection: 3 });

		const filtered = applyFilters([quick, longStopover], { ...emptyFilters(), minNights: 1 });

		expect(filtered.map((r) => r.id)).toEqual([longStopover.id]);
	});

	it('filters by minimum free time', () => {
		const short = makeScoredResult({ freeTimeMinutes: 60 });
		const long = makeScoredResult({ freeTimeMinutes: 600 });

		const filtered = applyFilters([short, long], { ...emptyFilters(), minFreeTimeMinutes: 300 });

		expect(filtered.map((r) => r.id)).toEqual([long.id]);
	});

	it('filters out an excluded connection airport', () => {
		const throughVienna = makeScoredResult({ connectionAirportCode: 'VIE' });
		const throughPrague = makeScoredResult({ connectionAirportCode: 'PRG' });

		const filtered = applyFilters(
			[throughVienna, throughPrague],
			{ ...emptyFilters(), excludedConnectionAirports: new Set(['PRG']) }
		);

		expect(filtered.map((r) => r.id)).toEqual([throughVienna.id]);
	});

	it('filters out either flight on an excluded airline', () => {
		const ryanairOutbound = makeScoredResult({ outboundCarrier: 'FR' });
		const other = makeScoredResult({ outboundCarrier: 'VY' });

		const filtered = applyFilters(
			[ryanairOutbound, other],
			{ ...emptyFilters(), excludedAirlines: new Set(['FR']) }
		);

		expect(filtered.map((r) => r.id)).toEqual([other.id]);
	});

	it('does NOT filter out an avoided-but-not-excluded airline, avoid is scoring only', () => {
		// scoreItinerary already covers the score-penalty side (score.test.ts); this just
		// asserts the results-list filter never conflates the two mechanisms (see this
		// module's header comment).
		const result = makeScoredResult({ outboundCarrier: 'FR' });
		expect(applyFilters([result], emptyFilters())).toHaveLength(1);
	});
});

describe('deriveFilterOptions', () => {
	it('counts distinct connection airports and airlines across all results', () => {
		const a = makeScoredResult({ connectionAirportCode: 'VIE', outboundCarrier: 'VY', onwardCarrier: 'W6' });
		const b = makeScoredResult({ connectionAirportCode: 'VIE', outboundCarrier: 'VY', onwardCarrier: 'FR' });

		const options = deriveFilterOptions([a, b]);

		expect(options.connectionAirports).toEqual([{ value: 'VIE', count: 2 }]);
		const airlineByCode = Object.fromEntries(options.airlines.map((o) => [o.value, o.count]));
		expect(airlineByCode).toEqual({ VY: 2, W6: 1, FR: 1 });
	});

	it('tracks the observed min/max for each numeric axis', () => {
		const low = makeScoredResult({ priceMinorUnits: 5_000, totalMinutes: 300, nightsInConnection: 0 });
		const high = makeScoredResult({ priceMinorUnits: 20_000, totalMinutes: 900, nightsInConnection: 3 });

		const options = deriveFilterOptions([low, high]);

		expect(options.priceRangeMinorUnits).toEqual({ min: 5_000, max: 20_000 });
		expect(options.totalDurationRangeMinutes).toEqual({ min: 300, max: 900 });
		expect(options.nightsRange).toEqual({ min: 0, max: 3 });
	});

	it('returns empty option lists and no bounds for zero results', () => {
		const options = deriveFilterOptions([]);
		expect(options.connectionAirports).toEqual([]);
		expect(options.airlines).toEqual([]);
		expect(options.priceRangeMinorUnits).toBeUndefined();
	});
});
