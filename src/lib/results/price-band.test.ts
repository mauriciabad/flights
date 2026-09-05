import { describe, expect, it } from 'vitest';
import type { DayFare } from '$lib/flexible-dates';
import {
	MIN_PRICED_DEPARTURES,
	bandEvidenceSentence,
	bandRankSentence,
	buildPriceBand,
	oneAdultFlightsTotal,
	placeInBand
} from './price-band';
import type { PriceHistory, StopoverLegFares } from './price-band';
import { makeItinerary } from './test-support';

const OBSERVED_AT = Date.parse('2026-09-01T09:00:00Z');

function fare(departureDate: string, minorUnits: number, overrides: Partial<DayFare> = {}): DayFare {
	return {
		departureDate,
		arrivalDate: departureDate,
		minorUnits,
		providerId: 'ryanair',
		observedAt: OBSERVED_AT,
		...overrides
	};
}

function day(index: number): string {
	return `2026-10-${String(index).padStart(2, '0')}`;
}

/** `count` departure dates from 1 October, each pairing with an onward two days later.
 * `priceAt` decides what each day's total comes to. */
function stopover(
	via: string,
	count: number,
	priceAt: (index: number) => number,
	overrides: Partial<DayFare> = {}
): StopoverLegFares {
	const outbound: DayFare[] = [];
	const onward: DayFare[] = [];
	for (let index = 1; index <= count; index++) {
		outbound.push(fare(day(index), priceAt(index), overrides));
		onward.push(fare(day(index + 2), 0, overrides));
	}
	return { via, outbound, onward };
}

const CONSTRAINTS = { currency: 'EUR', minNights: 0, maxNights: 6 } as const;

function asBand(value: ReturnType<typeof buildPriceBand>): PriceHistory {
	if (value.kind !== 'band') throw new Error(`expected a band, got ${value.kind}`);
	return value;
}

describe('buildPriceBand', () => {
	it('says nothing at all below the floor, and names how far short it is', () => {
		const band = buildPriceBand([stopover('VIE', MIN_PRICED_DEPARTURES - 1, () => 20_000)], CONSTRAINTS);

		expect(band).toEqual({
			kind: 'too-little-history',
			pricedDepartures: MIN_PRICED_DEPARTURES - 1,
			needed: MIN_PRICED_DEPARTURES
		});
	});

	it('bands once the floor is reached', () => {
		const band = buildPriceBand([stopover('VIE', MIN_PRICED_DEPARTURES, () => 20_000)], CONSTRAINTS);

		expect(band.kind).toBe('band');
	});

	/**
	 * The floor is a count of DAYS, not of fares. Two stopovers priced on the same thirteen
	 * days are thirteen days of evidence about this route, not twenty-six, and a band built
	 * as if they were twenty-six would be exactly the "confident-looking bar on three data
	 * points" the issue is about.
	 */
	it('counts a day once however many stopovers can fly it', () => {
		const days = MIN_PRICED_DEPARTURES - 1;
		const band = buildPriceBand(
			[stopover('VIE', days, () => 20_000), stopover('WAW', days, () => 30_000)],
			CONSTRAINTS
		);

		expect(band).toMatchObject({ kind: 'too-little-history', pricedDepartures: days });
	});

	it('keeps the cheapest stopover for a day and remembers which one it was', () => {
		const band = asBand(
			buildPriceBand(
				[
					stopover('VIE', MIN_PRICED_DEPARTURES, () => 30_000),
					stopover('WAW', MIN_PRICED_DEPARTURES, () => 21_000)
				],
				CONSTRAINTS
			)
		);

		expect(band.departures).toHaveLength(MIN_PRICED_DEPARTURES);
		expect(new Set(band.departures.map((departure) => departure.via))).toEqual(new Set(['WAW']));
		expect(new Set(band.departures.map((departure) => departure.minorUnits))).toEqual(new Set([21_000]));
	});

	it('puts the tenth and ninetieth percentiles at the ends of the track', () => {
		// Twenty days at 100, 200, ... 2000. The index rule is `floor(n * q)`, the same one
		// `flexible-dates`' calendar bands use, so p10 is the value with exactly two days
		// below it and p90 the value with exactly two above.
		const band = asBand(buildPriceBand([stopover('VIE', 20, (index) => index * 100)], CONSTRAINTS));

		expect(band.lowMinorUnits).toBe(300);
		expect(band.highMinorUnits).toBe(1900);
		expect(band.earliestDeparture).toBe('2026-10-01');
		expect(band.latestDeparture).toBe('2026-10-20');
	});

	/** The whole reason the floor is 14 rather than 5. Below ten observations the tenth
	 * percentile IS the cheapest one, so a track drawn from p10 to p90 would look like it
	 * had trimmed the outliers while trimming nothing. */
	it('has at least one observation outside each end of the track at the floor', () => {
		const band = asBand(
			buildPriceBand([stopover('VIE', MIN_PRICED_DEPARTURES, (index) => index * 100)], CONSTRAINTS)
		);
		const totals = band.departures.map((departure) => departure.minorUnits);

		expect(totals.filter((total) => total < band.lowMinorUnits).length).toBeGreaterThan(0);
		expect(totals.filter((total) => total > band.highMinorUnits).length).toBeGreaterThan(0);
	});

	it('reports the stalest and freshest fare behind it, and every source', () => {
		const stale = OBSERVED_AT - 5 * 24 * 60 * 60_000;
		const band = asBand(
			buildPriceBand(
				[
					stopover('VIE', MIN_PRICED_DEPARTURES, () => 20_000, { providerId: 'kiwi-public', observedAt: stale }),
					stopover('WAW', MIN_PRICED_DEPARTURES, () => 19_000)
				],
				CONSTRAINTS
			)
		);

		expect(band.providerIds).toEqual(['ryanair']);
		expect(band.oldestObservedAt).toBe(OBSERVED_AT);
		expect(band.newestObservedAt).toBe(OBSERVED_AT);
	});

	it('is empty rather than throwing when no stopover has anything', () => {
		expect(buildPriceBand([], CONSTRAINTS)).toEqual({
			kind: 'too-little-history',
			pricedDepartures: 0,
			needed: MIN_PRICED_DEPARTURES
		});
	});
});

describe('placeInBand', () => {
	const band = asBand(buildPriceBand([stopover('VIE', 20, (index) => index * 100)], CONSTRAINTS));

	it('counts how many priced days cost more', () => {
		expect(placeInBand(band, 500)).toMatchObject({ cheaperThan: 15, outOf: 20, placement: 'inside' });
	});

	it('clamps a figure below the track to its cheap end and says so', () => {
		expect(placeInBand(band, 50)).toMatchObject({ fraction: 0, placement: 'below', cheaperThan: 20, zone: 0 });
	});

	it('clamps a figure above the track to its dear end and says so', () => {
		expect(placeInBand(band, 9_999)).toMatchObject({ fraction: 1, placement: 'above', cheaperThan: 0, zone: 2 });
	});

	it('puts a flat route mid-track rather than at an arbitrary end', () => {
		const flat = asBand(buildPriceBand([stopover('VIE', 20, () => 20_000)], CONSTRAINTS));

		expect(placeInBand(flat, 20_000)).toMatchObject({ fraction: 0.5, placement: 'inside', zone: 1 });
	});
});

describe('oneAdultFlightsTotal', () => {
	it('adds the two fares as quoted, ignoring the party size', () => {
		const itinerary = makeItinerary({ travellers: 3 });

		expect(oneAdultFlightsTotal(itinerary)).toEqual({ minorUnits: 11_800, currency: 'EUR' });
	});

	/** A party total has no one-adult figure in it, and dividing by the traveller count
	 * would put an average on a track of fares. `flexible-dates/record-results.ts` drops
	 * the same offers at the other end of this pipeline for the same reason. */
	it('refuses a party-total fare rather than dividing it down', () => {
		const itinerary = makeItinerary({ travellers: 2 });
		itinerary.onwardFlight.priceScope = 'party-total';

		expect(oneAdultFlightsTotal(itinerary)).toBeUndefined();
	});

	it('refuses two legs quoted in different currencies', () => {
		const itinerary = makeItinerary();
		itinerary.onwardFlight.price = { minorUnits: 5_800, currency: 'USD' };

		expect(oneAdultFlightsTotal(itinerary)).toBeUndefined();
	});
});

describe('the sentences', () => {
	const band = asBand(buildPriceBand([stopover('VIE', 20, (index) => index * 100)], CONSTRAINTS));
	const route = { origin: 'BCN', destination: 'TLL' } as const;

	it('states a rank, never a verdict', () => {
		expect(bandRankSentence(placeInBand(band, 500), route)).toBe(
			'Cheaper than 15 of the 20 days this browser could price BCN to TLL.'
		);
	});

	it('names the size of the set a trip beats outright', () => {
		expect(bandRankSentence(placeInBand(band, 50), route)).toBe(
			'Cheaper than all 20 days this browser could price BCN to TLL.'
		);
		expect(bandRankSentence(placeInBand(band, 9_999), route)).toBe(
			'Dearer than all 20 days this browser could price BCN to TLL.'
		);
	});

	/** The clause that separates this from Google's claim. If it ever stops being rendered,
	 * the app is asserting something about a market it has never seen. */
	it('names the departures it covers and whose prices they are', () => {
		expect(bandEvidenceSentence(band)).toBe(
			'Departures in Oct 2026. Prices seen in this browser, not the market.'
		);
	});

	it('names both months when the band spans two', () => {
		const spanning = asBand(
			buildPriceBand(
				[
					{
						via: 'VIE',
						outbound: Array.from({ length: 20 }, (_, index) =>
							fare(index < 10 ? day(index + 1) : `2026-11-${String(index - 9).padStart(2, '0')}`, 20_000)
						),
						onward: Array.from({ length: 24 }, (_, index) =>
							fare(index < 12 ? day(index + 1) : `2026-11-${String(index - 11).padStart(2, '0')}`, 0)
						)
					}
				],
				CONSTRAINTS
			)
		);

		expect(bandEvidenceSentence(spanning)).toContain('Departures from Oct to Nov 2026');
	});
});
