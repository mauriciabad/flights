import { describe, expect, it } from 'vitest';
import type { Itinerary } from '$lib/domain';
import { departureLadder, describeDepartureLadder, type DepartureDateOption } from './departure-ladder';
import { makeItinerary } from './test-support';

/** The owner's own window, 16 to 18 September 2026, so the fixtures read like the card the
 * issue was filed from. `makeItinerary` fixes the timezone at UTC+2, which is Barcelona's
 * in September. */
function trip(options: {
	departure: string;
	priceMinorUnits: number;
	nights?: number;
	onwardDeparture?: string;
}): Itinerary {
	return makeItinerary({
		outboundDeparture: `${options.departure}T06:20:00`,
		outboundArrival: `${options.departure}T08:25:00`,
		onwardDeparture: options.onwardDeparture,
		nightsInConnection: options.nights ?? 1,
		priceMinorUnits: options.priceMinorUnits
	});
}

function option(itinerary: Itinerary): DepartureDateOption {
	return { date: itinerary.outboundFlight.departure.local.slice(0, 10), itinerary };
}

const SIXTEENTH = trip({ departure: '2026-09-16', priceMinorUnits: 24880 });
const SEVENTEENTH = trip({ departure: '2026-09-17', priceMinorUnits: 22400 });
const EIGHTEENTH = trip({ departure: '2026-09-18', priceMinorUnits: 31000 });
const LADDER = [SIXTEENTH, SEVENTEENTH, EIGHTEENTH].map(option);

describe('departureLadder', () => {
	it('names each rung by weekday and day number', () => {
		expect(departureLadder(SIXTEENTH, LADDER).map((rung) => rung.label)).toEqual([
			'Wed 16',
			'Thu 17',
			'Fri 18'
		]);
	});

	it('leaves the rungs in calendar order', () => {
		// Deliberately not price order. See this function's own doc comment: the cheapest is
		// marked instead, so "where is the money" is answerable without making "which day is
		// this" a scan of the whole row.
		expect(departureLadder(SIXTEENTH, LADDER).map((rung) => rung.date)).toEqual([
			'2026-09-16',
			'2026-09-17',
			'2026-09-18'
		]);
	});

	it('prices every other rung against the trip on screen', () => {
		const rungs = departureLadder(SIXTEENTH, LADDER);

		expect(rungs.map((rung) => rung.delta)).toEqual([undefined, '-€24.80', '+€61.20']);
		expect(rungs.map((rung) => rung.deltaMinorUnits)).toEqual([0, -2480, 6120]);
	});

	it('re-anchors the deltas when the traveller has moved to another day', () => {
		// The headline above the ladder is the trip on screen, so a rung's delta plus that
		// headline has to be exactly what the rung costs. Anchoring to the cheapest day
		// instead would print figures that add up to no number on the panel.
		const rungs = departureLadder(SEVENTEENTH, LADDER);

		expect(rungs.map((rung) => rung.delta)).toEqual(['+€24.80', undefined, '+€86.00']);
	});

	it('marks the trip on screen in words, not only in colour', () => {
		const rungs = departureLadder(SEVENTEENTH, LADDER);

		expect(rungs.map((rung) => rung.isCurrent)).toEqual([false, true, false]);
		expect(rungs[1]?.description).toBe('Leave Thu 17, the trip shown');
	});

	it('marks the cheapest day', () => {
		const rungs = departureLadder(SIXTEENTH, LADDER);

		expect(rungs.map((rung) => rung.isCheapest)).toEqual([false, true, false]);
		expect(rungs[1]?.description).toBe(
			'Leave Thu 17, €24.80 cheaper than the day shown, the cheapest day'
		);
	});

	it('does not mark the cheapest day when it is the day already shown', () => {
		// "this trip" already occupies that line, and the price above the ladder is the whole
		// number rather than a delta against itself.
		const rungs = departureLadder(SEVENTEENTH, LADDER);

		expect(rungs.some((rung) => rung.isCheapest)).toBe(false);
	});

	it('says "same price" rather than "+€0.00"', () => {
		const twin = trip({ departure: '2026-09-19', priceMinorUnits: 24880 });
		const rungs = departureLadder(SIXTEENTH, [...LADDER, option(twin)]);

		expect(rungs[3]?.delta).toBe('same price');
	});

	it('is empty for no options', () => {
		expect(departureLadder(SIXTEENTH, [])).toEqual([]);
	});
});

describe('departureLadder: a window longer than the row can hold', () => {
	/** Twelve days, priced so the cheapest are scattered rather than adjacent: the 1st is
	 * dearest and each later day is cheaper by a euro. `dep=2026-09-01&arr=2026-09-30` is an
	 * ordinary URL, so this is not a hypothetical shape. */
	const TWELVE = Array.from({ length: 12 }, (_, index) =>
		option(
			trip({
				departure: `2026-09-${String(index + 1).padStart(2, '0')}`,
				priceMinorUnits: 40000 - index * 100
			})
		)
	);

	it('draws no more than seven rungs', () => {
		expect(departureLadder(TWELVE[0]!.itinerary, TWELVE)).toHaveLength(7);
	});

	it('keeps the cheapest days and shows them in calendar order', () => {
		// The six cheapest are the 7th to the 12th, plus the 1st because it is on screen.
		const rungs = departureLadder(TWELVE[0]!.itinerary, TWELVE);

		expect(rungs.map((rung) => rung.date)).toEqual([
			'2026-09-01',
			'2026-09-07',
			'2026-09-08',
			'2026-09-09',
			'2026-09-10',
			'2026-09-11',
			'2026-09-12'
		]);
	});

	it('keeps the day on screen even when it is the dearest of the lot', () => {
		// A row that cannot show you where you are is not a control.
		const rungs = departureLadder(TWELVE[0]!.itinerary, TWELVE);

		expect(rungs[0]?.isCurrent).toBe(true);
		expect(rungs[0]?.date).toBe('2026-09-01');
	});

	it('marks the cheapest day of the whole window, not of the seven drawn', () => {
		const rungs = departureLadder(TWELVE[0]!.itinerary, TWELVE);
		const cheapest = rungs.filter((rung) => rung.isCheapest);

		expect(cheapest.map((rung) => rung.date)).toEqual(['2026-09-12']);
	});
});

describe('describeDepartureLadder', () => {
	it('says nothing when there is nowhere else to go', () => {
		expect(describeDepartureLadder(SIXTEENTH, [option(SIXTEENTH)])).toBeUndefined();
	});

	it('names the onward flight when the other days move it', () => {
		const later = trip({
			departure: '2026-09-17',
			priceMinorUnits: 22400,
			onwardDeparture: '2026-09-18T10:00:00'
		});

		expect(describeDepartureLadder(SIXTEENTH, [option(SIXTEENTH), option(later)])).toBe(
			'the onward flight moves too'
		);
	});

	it('names the nights when the other days change the length', () => {
		const longer = trip({ departure: '2026-09-17', priceMinorUnits: 22400, nights: 3 });

		expect(describeDepartureLadder(SIXTEENTH, [option(SIXTEENTH), option(longer)])).toBe(
			'the nights move too'
		);
	});

	it('names both when both move', () => {
		const other = trip({
			departure: '2026-09-17',
			priceMinorUnits: 22400,
			nights: 3,
			onwardDeparture: '2026-09-20T10:00:00'
		});

		expect(describeDepartureLadder(SIXTEENTH, [option(SIXTEENTH), option(other)])).toBe(
			'the onward flight and the nights move too'
		);
	});

	it('claims no change on a connection whose days share one onward flight and one length', () => {
		// A note that always says the same thing is a note nobody reads, so it is derived
		// rather than asserted.
		expect(describeDepartureLadder(SIXTEENTH, LADDER)).toBeUndefined();
	});
});
