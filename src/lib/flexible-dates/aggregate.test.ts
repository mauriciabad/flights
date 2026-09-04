import { describe, expect, it } from 'vitest';
import {
	bandOf,
	cheapestByDeparture,
	coverageReport,
	inclusiveDayCount,
	priceBands,
	rankWeeks,
	tripWindows
} from './aggregate';
import type { DayFare, LegFares } from './types';

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 8, 4, 12);

function fare(
	departureDate: string,
	minorUnits: number,
	overrides: Partial<DayFare> = {}
): DayFare {
	return {
		departureDate,
		arrivalDate: departureDate,
		minorUnits,
		providerId: 'ryanair',
		observedAt: NOW,
		...overrides
	};
}

function leg(months: LegFares['months'], fares: DayFare[] = []): LegFares {
	return {
		origin: 'BCN',
		destination: 'VIE',
		currency: 'EUR',
		fares,
		blankDays: [],
		months
	};
}

describe('tripWindows', () => {
	it('pairs each outbound day with an onward day the stopover length can reach', () => {
		const outbound = [fare('2026-10-01', 2000)];
		const onward = [fare('2026-10-03', 3000), fare('2026-10-04', 1000)];

		const windows = tripWindows(outbound, onward, { minNights: 2, maxNights: 3 });

		expect(windows).toHaveLength(2);
		expect(windows[0]).toMatchObject({ nights: 3, totalMinorUnits: 3000 });
		expect(windows[1]).toMatchObject({ nights: 2, totalMinorUnits: 5000 });
	});

	// The night count is what the traveller is buying, and an overnight outbound has already
	// used one up by the time it lands. Counting from the DEPARTURE date instead would offer
	// a "2 night" stopover that is really 1.
	it('counts nights from the outbound ARRIVAL date, not its departure date', () => {
		const overnight = [fare('2026-10-01', 2000, { arrivalDate: '2026-10-02' })];
		const onward = [fare('2026-10-04', 1000)];

		const windows = tripWindows(overnight, onward, { minNights: 2, maxNights: 2 });

		expect(windows).toHaveLength(1);
		expect(windows[0].nights).toBe(2);
		expect(windows[0].onward.departureDate).toBe('2026-10-04');

		// The same pair read off departure dates would be three nights, and is not offered.
		expect(tripWindows(overnight, onward, { minNights: 3, maxNights: 3 })).toEqual([]);
	});

	it('never invents an onward day that no source priced', () => {
		const outbound = [fare('2026-10-01', 2000), fare('2026-10-02', 1000)];
		const onward = [fare('2026-10-04', 1000)];

		const windows = tripWindows(outbound, onward, { minNights: 1, maxNights: 5 });

		// Only 10-01 -> 10-04 (3 nights) and 10-02 -> 10-04 (2 nights) exist. 10-03 has no
		// onward fare, so no window departs expecting one.
		expect(windows.map((window) => window.outbound.departureDate)).toEqual([
			'2026-10-02',
			'2026-10-01'
		]);
	});

	it('honours the date window without touching anything else', () => {
		const outbound = [fare('2026-10-01', 1000), fare('2026-10-08', 1000)];
		const onward = [fare('2026-10-03', 500), fare('2026-10-10', 500)];

		const all = tripWindows(outbound, onward, { minNights: 2, maxNights: 2 });
		const narrowed = tripWindows(outbound, onward, {
			minNights: 2,
			maxNights: 2,
			from: '2026-10-05',
			to: '2026-10-31'
		});

		expect(all).toHaveLength(2);
		expect(narrowed).toHaveLength(1);
		expect(narrowed[0].outbound.departureDate).toBe('2026-10-08');
	});

	it('reports a pair as only as fresh as its stalest half', () => {
		const outbound = [fare('2026-10-01', 2000, { observedAt: NOW })];
		const onward = [fare('2026-10-03', 1000, { observedAt: NOW - 20 * HOUR })];

		expect(tripWindows(outbound, onward, { minNights: 2, maxNights: 2 })[0].oldestObservedAt).toBe(
			NOW - 20 * HOUR
		);
	});

	it('treats a reversed nights range as a single length rather than throwing', () => {
		const outbound = [fare('2026-10-01', 1000)];
		const onward = [fare('2026-10-03', 1000)];
		expect(tripWindows(outbound, onward, { minNights: 2, maxNights: 1 })).toHaveLength(1);
	});
});

describe('rankWeeks', () => {
	it('ranks weeks by their cheapest complete pair', () => {
		// 2026-10-01 is a Thursday, so it falls in the week starting Monday 2026-09-28.
		const outbound = [fare('2026-10-01', 5000), fare('2026-10-06', 1000), fare('2026-10-07', 1200)];
		const onward = [fare('2026-10-03', 5000), fare('2026-10-08', 1000), fare('2026-10-09', 900)];

		const weeks = rankWeeks(outbound, onward, { minNights: 2, maxNights: 2 });

		expect(weeks.map((week) => week.weekStart)).toEqual(['2026-10-05', '2026-09-28']);
		expect(weeks[0].best.totalMinorUnits).toBe(2000);
		expect(weeks[0].weekEnd).toBe('2026-10-11');
		// Two departures in that week produced a complete pair, which is the honesty number
		// the card prints: a week priced from one lucky day is weaker evidence than one
		// priced from six.
		expect(weeks[0].pricedDepartures).toBe(2);
	});

	it('leaves out a week where only one leg is priced', () => {
		const outbound = [fare('2026-10-01', 5000), fare('2026-10-20', 100)];
		const onward = [fare('2026-10-03', 5000)];

		const weeks = rankWeeks(outbound, onward, { minNights: 2, maxNights: 2 });

		expect(weeks).toHaveLength(1);
		expect(weeks[0].weekStart).toBe('2026-09-28');
	});

	it('has nothing to say when nothing is priced', () => {
		expect(rankWeeks([], [], { minNights: 1, maxNights: 3 })).toEqual([]);
	});
});

describe('cheapestByDeparture', () => {
	it('keeps one window per departure day, the cheapest', () => {
		const outbound = [fare('2026-10-01', 1000)];
		const onward = [fare('2026-10-03', 900), fare('2026-10-05', 100)];

		const byDay = cheapestByDeparture(outbound, onward, { minNights: 2, maxNights: 4 });

		expect(byDay.size).toBe(1);
		expect(byDay.get('2026-10-01')?.totalMinorUnits).toBe(1100);
		expect(byDay.get('2026-10-01')?.nights).toBe(4);
	});
});

describe('coverageReport', () => {
	it('names the months nothing is known about', () => {
		const outbound = leg([
			{ monthStart: '2026-10-01', pricedDays: 4, blankDays: 0, unknownDays: 27, sources: [] },
			{ monthStart: '2026-11-01', pricedDays: 0, blankDays: 0, unknownDays: 30, sources: [] }
		]);
		const onward = leg([
			{ monthStart: '2026-10-01', pricedDays: 3, blankDays: 0, unknownDays: 28, sources: [] },
			{ monthStart: '2026-11-01', pricedDays: 0, blankDays: 0, unknownDays: 30, sources: [] }
		]);

		const report = coverageReport(outbound, onward, new Map());

		expect(report.unknownMonths).toEqual(['2026-11-01']);
		expect(report.knownMonths).toEqual(['2026-10-01']);
		expect(report.totalDays).toBe(61);
		expect(report.pricedTripDays).toBe(0);
	});

	// The window is what the view ranks over, so it has to be what the denominator counts.
	// Falling back to whole calendar months put days before today, and days past the
	// horizon, into "62 of 395" and understated coverage by a month.
	it('counts the window it was given, not the calendar months it touches', () => {
		const months = [
			{ monthStart: '2026-09-01', pricedDays: 0, blankDays: 0, unknownDays: 30, sources: [] },
			{ monthStart: '2026-10-01', pricedDays: 0, blankDays: 0, unknownDays: 31, sources: [] }
		];

		expect(
			coverageReport(leg(months), leg(months), new Map(), { from: '2026-09-04', to: '2026-10-20' })
				.totalDays
		).toBe(47);
		expect(coverageReport(leg(months), leg(months), new Map()).totalDays).toBe(61);
	});

	it('reports the real span of observation times and every source behind them', () => {
		const outboundFare = fare('2026-10-01', 1000, { observedAt: NOW - 40 * HOUR });
		const onwardFare = fare('2026-10-03', 900, {
			providerId: 'kiwi-public',
			observedAt: NOW - 2 * HOUR
		});
		const tripDays = cheapestByDeparture([outboundFare], [onwardFare], {
			minNights: 2,
			maxNights: 2
		});

		const report = coverageReport(
			leg([{ monthStart: '2026-10-01', pricedDays: 1, blankDays: 0, unknownDays: 30, sources: [] }]),
			leg([{ monthStart: '2026-10-01', pricedDays: 1, blankDays: 0, unknownDays: 30, sources: [] }]),
			tripDays
		);

		expect(report.oldestObservedAt).toBe(NOW - 40 * HOUR);
		expect(report.newestObservedAt).toBe(NOW - 2 * HOUR);
		expect(report.providerIds).toEqual(['kiwi-public', 'ryanair']);
		expect(report.pricedTripDays).toBe(1);
	});
});

describe('priceBands', () => {
	it('bands by quantile so one outlier does not flatten the grid', () => {
		const outbound = Array.from({ length: 8 }, (_, i) => fare(`2026-10-0${i + 1}`, 1000 + i * 10));
		// One absurd day. With equal-width bands every other day would land in band 0.
		outbound.push(fare('2026-10-09', 90_000));
		const onward = outbound.map((f) => ({ ...f, departureDate: f.departureDate, minorUnits: 0 }));

		const windows = cheapestByDeparture(outbound, onward, { minNights: 0, maxNights: 0 });
		const bands = priceBands(windows);

		expect(bands).toBeDefined();
		expect(bands?.cheapestMinorUnits).toBe(1000);
		expect(bands?.dearestMinorUnits).toBe(90_000);
		expect(bandOf(1000, bands!.thresholds)).toBe(0);
		expect(bandOf(90_000, bands!.thresholds)).toBe(3);
		// The cheap days still spread across more than one band.
		const usedBands = new Set(
			[...windows.values()].map((window) => bandOf(window.totalMinorUnits, bands!.thresholds))
		);
		expect(usedBands.size).toBeGreaterThan(1);
	});

	it('has no bands at all when nothing is priced, rather than a cheapest band of nothing', () => {
		expect(priceBands(new Map())).toBeUndefined();
	});
});

describe('inclusiveDayCount', () => {
	it('counts both ends', () => {
		expect(inclusiveDayCount('2026-09-04', '2027-09-04')).toBe(366);
		expect(inclusiveDayCount('2026-09-04', '2026-09-04')).toBe(1);
		expect(inclusiveDayCount('2026-09-04', 'nope')).toBe(0);
	});
});
