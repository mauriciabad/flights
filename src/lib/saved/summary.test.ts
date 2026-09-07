import { describe, expect, it } from 'vitest';
import {
	formatObservedDate,
	observationParts,
	priceTrend,
	sparkline,
	stopoverPhrase,
	summarizeSavedItinerary,
	trendNote
} from './summary';
import { makeObservation, makeSaved, makeTrip, money } from './test-support';

describe('summarizeSavedItinerary', () => {
	it('says the route, the trip dates and the stopover on one line', () => {
		const summary = summarizeSavedItinerary(makeSaved());
		expect(summary.originAirport).toBe('BCN');
		expect(summary.connectionAirport).toBe('VIE');
		expect(summary.destinationAirport).toBe('OTP');
		expect(summary.dates).toBe('14 Oct to 16 Oct 2026');
		expect(summary.stopover).toBe('2 nights in Vienna');
		expect(summary.label).toBe(
			'BCN to OTP via VIE, 14 Oct to 16 Oct 2026, 2 nights in Vienna, 1 traveller'
		);
	});

	it('dates the trip from its own flights, not from the search window that found it', () => {
		const trip = makeTrip();
		trip.onwardFlight.arrival = { ...trip.onwardFlight.arrival, local: '2026-11-02T01:10:00' };
		expect(summarizeSavedItinerary(makeSaved({ trip })).dates).toBe('14 Oct to 2 Nov 2026');
	});
});

describe('stopoverPhrase', () => {
	it('counts one night in the singular', () => {
		expect(stopoverPhrase(makeTrip({ nightsInConnection: 1 }))).toBe('1 night in Vienna');
	});

	it('says a connection with no night is an airport wait rather than a stay of zero nights', () => {
		expect(stopoverPhrase(makeTrip({ nightsInConnection: 0 }))).toBe('No night, Vienna airport only');
	});
});

describe('priceTrend', () => {
	it('refuses to call one observation a trend', () => {
		const trend = priceTrend([makeObservation({ total: money(18_200) })]);
		expect(trend.kind).toBe('single');
	});

	it('has nothing to say about an empty log', () => {
		expect(priceTrend([]).kind).toBe('none');
	});

	it('measures the fall from the first price to the newest', () => {
		const trend = priceTrend([
			makeObservation({ visit: 'v1', observedAt: 1, total: money(18_200) }),
			makeObservation({ visit: 'v2', observedAt: 2, total: money(20_000) }),
			makeObservation({ visit: 'v3', observedAt: 3, total: money(17_000) })
		]);
		expect(trend).toMatchObject({ kind: 'compared', deltaMinorUnits: -1_200, currency: 'EUR' });
	});

	it('reports a price that has not moved as a delta of zero rather than as no comparison', () => {
		const trend = priceTrend([
			makeObservation({ visit: 'v1', observedAt: 1 }),
			makeObservation({ visit: 'v2', observedAt: 2 })
		]);
		expect(trend).toMatchObject({ kind: 'compared', deltaMinorUnits: 0 });
	});

	it('refuses to subtract two currencies', () => {
		const trend = priceTrend([
			makeObservation({ visit: 'v1', observedAt: 1, total: money(18_200, 'EUR') }),
			makeObservation({ visit: 'v2', observedAt: 2, total: money(15_000, 'GBP') })
		]);
		expect(trend.kind).toBe('incomparable');
	});
});

describe('trendNote', () => {
	it('names the direction and the amount, so the colour only repeats the words', () => {
		const note = trendNote(
			priceTrend([
				makeObservation({ visit: 'v1', observedAt: 1, total: money(18_200) }),
				makeObservation({ visit: 'v2', observedAt: 2, total: money(17_000) })
			])
		);
		expect(note).toEqual({
			direction: 'cheaper',
			short: '€12.00 cheaper',
			long: '€12.00 cheaper than when you saved it.'
		});
	});

	it('says a rise is a rise', () => {
		const note = trendNote(
			priceTrend([
				makeObservation({ visit: 'v1', observedAt: 1, total: money(17_000) }),
				makeObservation({ visit: 'v2', observedAt: 2, total: money(18_200) })
			])
		);
		expect(note?.direction).toBe('dearer');
		expect(note?.short).toBe('€12.00 dearer');
	});

	it('calls one observation what it is instead of dressing it as a trend', () => {
		expect(trendNote(priceTrend([makeObservation()]))?.short).toBe('One price so far');
	});

	it('names both currencies rather than subtracting them', () => {
		const note = trendNote(
			priceTrend([
				makeObservation({ visit: 'v1', observedAt: 1, total: money(18_200, 'EUR') }),
				makeObservation({ visit: 'v2', observedAt: 2, total: money(15_000, 'GBP') })
			])
		);
		expect(note?.long).toContain('EUR');
		expect(note?.long).toContain('GBP');
	});

	it('has nothing to say when nothing was ever priced', () => {
		expect(trendNote(priceTrend([]))).toBeUndefined();
	});
});

describe('formatObservedDate', () => {
	it('reads the day off the clock the viewer is sitting at', () => {
		// Midday UTC, so this is the same calendar day in every zone a browser is likely to
		// sit in, and the test does not depend on the machine running it.
		expect(formatObservedDate(Date.UTC(2026, 9, 14, 12))).toBe('14 Oct 2026');
	});
});

describe('observationParts', () => {
	it('gives every part a row, with no money on the ones nobody priced', () => {
		const parts = observationParts(makeObservation({ flights: money(11_800), bed: undefined }));
		expect(parts.map((part) => part.id)).toEqual(['flights', 'bed', 'ground']);
		expect(parts[0].money).toEqual(money(11_800));
		expect(parts[1].money).toBeUndefined();
	});
});

describe('sparkline', () => {
	const box = { width: 100, height: 20 };

	it('draws nothing from one point, because one point is not a line', () => {
		expect(sparkline([makeObservation()], box)).toBeUndefined();
	});

	it('draws nothing from an empty log', () => {
		expect(sparkline([], box)).toBeUndefined();
	});

	it('spreads the points along time, not along row number', () => {
		const line = sparkline(
			[
				makeObservation({ visit: 'v1', observedAt: 0, total: money(100) }),
				makeObservation({ visit: 'v2', observedAt: 10, total: money(200) }),
				makeObservation({ visit: 'v3', observedAt: 100, total: money(150) })
			],
			box
		);
		expect(line?.plotted.map((point) => point.x)).toEqual([0, 10, 100]);
	});

	it('puts the cheapest visit at the bottom of the box and the dearest at the top', () => {
		const line = sparkline(
			[
				makeObservation({ visit: 'v1', observedAt: 0, total: money(100) }),
				makeObservation({ visit: 'v2', observedAt: 1, total: money(300) })
			],
			box
		);
		expect(line?.plotted.map((point) => point.y)).toEqual([20, 0]);
		expect(line?.low).toEqual(money(100));
		expect(line?.high).toEqual(money(300));
	});

	it('draws a flat line through the middle when the price never moved', () => {
		const line = sparkline(
			[
				makeObservation({ visit: 'v1', observedAt: 0 }),
				makeObservation({ visit: 'v2', observedAt: 1 })
			],
			box
		);
		expect(line?.points).toBe('0,10 100,10');
	});

	it('leaves out observations in another currency rather than plotting two scales as one', () => {
		const line = sparkline(
			[
				makeObservation({ visit: 'v1', observedAt: 0, total: money(15_000, 'GBP') }),
				makeObservation({ visit: 'v2', observedAt: 1, total: money(18_000, 'EUR') }),
				makeObservation({ visit: 'v3', observedAt: 2, total: money(17_000, 'EUR') })
			],
			box
		);
		expect(line?.plotted).toHaveLength(2);
		expect(line?.low).toEqual(money(17_000, 'EUR'));
	});
});
