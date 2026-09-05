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

	it('keeps a stopover that can reach the asked-for nights, whatever length its card shows', () => {
		// Issue #224: a card opens at its SHORTEST length, so reading this filter against
		// the length on screen would hide the three-night London trip behind the one-night
		// London card, which is exactly the trip somebody asking for three nights wants.
		const oneNightShown = makeScoredResult({ nightsInConnection: 1 });
		const extendable = {
			...oneNightShown,
			stopover: {
				...oneNightShown.stopover,
				options: [
					{ nights: 1, itinerary: oneNightShown.itinerary },
					{ nights: 3, itinerary: oneNightShown.itinerary }
				]
			}
		};

		const filtered = applyFilters([extendable], { ...emptyFilters(), minNights: 3 });

		expect(filtered.map((r) => r.id)).toEqual([extendable.id]);
	});

	it('filters by minimum free time', () => {
		const short = makeScoredResult({ freeTimeMinutes: 60 });
		const long = makeScoredResult({ freeTimeMinutes: 600 });

		const filtered = applyFilters([short, long], { ...emptyFilters(), minFreeTimeMinutes: 300 });

		expect(filtered.map((r) => r.id)).toEqual([long.id]);
	});

	it('keeps only the chosen connection airport', () => {
		// Issue #189, the promise the chip's own count makes: "Prague (1)" must leave one.
		const throughVienna = makeScoredResult({ connectionAirportCode: 'VIE' });
		const throughPrague = makeScoredResult({ connectionAirportCode: 'PRG' });

		const filtered = applyFilters([throughVienna, throughPrague], {
			...emptyFilters(),
			chosenConnectionAirports: new Set(['PRG'])
		});

		expect(filtered.map((r) => r.id)).toEqual([throughPrague.id]);
	});

	it('keeps every connection airport when none is chosen', () => {
		// Empty means all, which is what lets a connection city streaming in after the panel
		// was drawn show up rather than being hidden for not being in a list nobody saw.
		const throughVienna = makeScoredResult({ connectionAirportCode: 'VIE' });
		const throughPrague = makeScoredResult({ connectionAirportCode: 'PRG' });

		expect(applyFilters([throughVienna, throughPrague], emptyFilters())).toHaveLength(2);
	});

	it('keeps an itinerary carrying a chosen airline on either leg', () => {
		// `deriveFilterOptions` counts an itinerary under BOTH of its carriers, so "FR (1)"
		// counts the trip that flies FR on one leg and W6 on the other. Requiring both legs
		// would answer that label with zero.
		const ryanairOutbound = makeScoredResult({ outboundCarrier: 'FR', onwardCarrier: 'W6' });
		const ryanairOnward = makeScoredResult({ outboundCarrier: 'VY', onwardCarrier: 'FR' });
		const neither = makeScoredResult({ outboundCarrier: 'VY', onwardCarrier: 'W6' });

		const filtered = applyFilters([ryanairOutbound, ryanairOnward, neither], {
			...emptyFilters(),
			chosenAirlines: new Set(['FR'])
		});

		expect(filtered.map((r) => r.id)).toEqual([ryanairOutbound.id, ryanairOnward.id]);
	});

	it('widens rather than narrows when a second airline is chosen', () => {
		const ryanair = makeScoredResult({ outboundCarrier: 'FR', onwardCarrier: 'FR' });
		const vueling = makeScoredResult({ outboundCarrier: 'VY', onwardCarrier: 'VY' });
		const wizz = makeScoredResult({ outboundCarrier: 'W6', onwardCarrier: 'W6' });

		const filtered = applyFilters([ryanair, vueling, wizz], {
			...emptyFilters(),
			chosenAirlines: new Set(['FR', 'VY'])
		});

		expect(filtered.map((r) => r.id)).toEqual([ryanair.id, vueling.id]);
	});

	it('narrows across axes, so a chosen city and a chosen airline both have to hold', () => {
		const praguePlusRyanair = makeScoredResult({
			connectionAirportCode: 'PRG',
			outboundCarrier: 'FR'
		});
		const prague = makeScoredResult({ connectionAirportCode: 'PRG', outboundCarrier: 'VY' });
		const viennaPlusRyanair = makeScoredResult({
			connectionAirportCode: 'VIE',
			outboundCarrier: 'FR'
		});

		const filtered = applyFilters([praguePlusRyanair, prague, viennaPlusRyanair], {
			...emptyFilters(),
			chosenConnectionAirports: new Set(['PRG']),
			chosenAirlines: new Set(['FR'])
		});

		expect(filtered.map((r) => r.id)).toEqual([praguePlusRyanair.id]);
	});

	it('does NOT hide an avoided airline, avoid is scoring only', () => {
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

	it('opens the nights slider to every length a stopover can reach, not only the one shown', () => {
		// A list of one-night cards would otherwise draw a slider running 1 to 1, and the
		// longer trips behind those cards would be unaskable-for (issue #224).
		const shown = makeScoredResult({ nightsInConnection: 1 });
		const extendable = {
			...shown,
			stopover: {
				...shown.stopover,
				options: [
					{ nights: 1, itinerary: shown.itinerary },
					{ nights: 4, itinerary: shown.itinerary }
				]
			}
		};

		expect(deriveFilterOptions([extendable]).nightsRange).toEqual({ min: 1, max: 4 });
	});

	it('returns empty option lists and no bounds for zero results', () => {
		const options = deriveFilterOptions([]);
		expect(options.connectionAirports).toEqual([]);
		expect(options.airlines).toEqual([]);
		expect(options.priceRangeMinorUnits).toBeUndefined();
	});
});
