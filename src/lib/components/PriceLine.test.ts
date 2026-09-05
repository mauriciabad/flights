import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { Duration, Itinerary, Transfer } from '../domain';
import { makeItinerary } from '../results/test-support';
import PriceLine from './PriceLine.svelte';

/**
 * Issue #249: what the receipt on a results card says about the ground, read off the DOM.
 *
 * The arithmetic is pinned in `itinerary-metrics.test.ts`. What is pinned here is the
 * pair of sentences a traveller actually reads, because the defect was never a wrong
 * number. Measured on production on 2026-09-05, a trip of three taxis and one walk read
 * `Ground, 3 rides / not priced`, which is true, next to nothing at all about the fourth
 * leg, whose price this app knows.
 *
 * Mounted with Svelte 5's own `mount`/`flushSync`, the way `StopoverBlock.test.ts` does.
 */

let target: HTMLElement | undefined;
let component: Record<string, unknown> | undefined;

/** One mount per test. `afterEach` unmounts it, so two of these in one test would leak the
 * first, which is why both readers below go through here. */
function render(itinerary: Itinerary): HTMLElement {
	target = document.createElement('div');
	document.body.appendChild(target);
	component = mount(PriceLine, { target, props: { itinerary } });
	flushSync();
	return target;
}

/** Every receipt row as `label -> amount`, plus whether it carries the warning tint the
 * card uses for something the total is missing. */
function rows(itinerary: Itinerary): { line: string; missing: boolean }[] {
	return [...render(itinerary).querySelectorAll('.price-part')].map((row) => ({
		line: `${row.querySelector('.price-part-label')?.textContent?.trim()} -> ${row
			.querySelector('.price-part-amount')
			?.textContent?.trim()}`,
		missing: row.classList.contains('price-part-missing')
	}));
}

function headline(itinerary: Itinerary): string {
	return render(itinerary).querySelector('.price-total')!.textContent!.trim();
}

afterEach(() => {
	if (component) unmount(component);
	target?.remove();
	component = undefined;
	target = undefined;
});

function ride(mode: Transfer['mode']): Transfer {
	return { mode, duration: 30 as Duration, legs: [] };
}

const walk = ride('walk');
const taxi = ride('taxi');

/** The same taxi, carrying what the GB rate card says a ride like it costs: the range
 * `providers/transfers/taxi-rate-table.ts` produces from an OSRM driving distance. Still no
 * `price`, because this is a guess and the row it produces has to read as one. */
const ratedTaxi: Transfer = {
	...taxi,
	fareEstimate: {
		kind: 'estimate',
		currency: 'GBP',
		lowMinorUnits: 2426,
		highMinorUnits: 3830,
		countryCode: 'GB',
		rateSource: 'country',
		citation: 'London black-cab Tariff 1'
	}
};

/** The shape the owner was looking at, reproduced on production on 2026-09-05 with an
 * origin and a destination location filled in: four ground legs, the first walked and the
 * other three taxis nobody quoted. */
function threeTaxisAndAWalk(): Itinerary {
	return {
		...makeItinerary({ nightsInConnection: 1 }),
		transferToOriginAirport: walk,
		transferToHotel: taxi,
		transferToConnectionAirport: taxi,
		transferToDestinationLocation: taxi
	};
}

describe('the ground lines on the receipt', () => {
	it('says the walked legs are free and the unquoted ones are not priced', () => {
		expect(rows(threeTaxisAndAWalk())).toEqual([
			{ line: 'Flights -> €118.00', missing: false },
			{ line: 'Hotel -> €20.00/night', missing: false },
			{ line: '1 required night -> €20.00', missing: false },
			{ line: 'Ride from origin -> free', missing: false },
			{ line: 'Rides from and to hotel -> not priced', missing: true },
			{ line: 'Ride to destination -> not priced', missing: true }
		]);
	});

	it('says the ground costs nothing rather than saying nothing at all', () => {
		// `makeItinerary`'s two default legs are walks. This card used to print no ground
		// row whatsoever, which reads the same as a trip that has no ground legs, and the
		// owner has already told us how he reads that silence: "the price of transport
		// should be considered as well and you are not doing it or at least is not shown in
		// the card" (issue #204).
		const walked = makeItinerary({ nightsInConnection: 1 });
		expect(rows(walked)).toEqual([
			{ line: 'Flights -> €118.00', missing: false },
			{ line: 'Hotel -> €20.00/night', missing: false },
			{ line: '1 required night -> €20.00', missing: false },
			{ line: 'Rides from and to hotel -> free', missing: false }
		]);
	});

	it('leaves a total made only of known amounts unqualified', () => {
		// No "from". Two walks and a priced bed is the whole trip, so the headline is the
		// answer rather than a floor, and a card that apologised here would be inventing an
		// omission. This already held before the walk row existed and has to keep holding.
		expect(headline(makeItinerary({ nightsInConnection: 1 }))).toBe('€138.00');
	});

	it('still marks a total as a floor when a ride nobody quoted is in the trip', () => {
		expect(headline(threeTaxisAndAWalk())).toBe('from€138.00');
	});

	it('claims no free walk on a leg nobody could route', () => {
		// Issue #211's state: the bed is priced and no provider could reach it. A leg that
		// does not exist is neither a free walk nor a quoted ride, and the receipt owes the
		// traveller the warning without the consolation.
		const { transferToHotel: _a, transferToConnectionAirport: _b, ...unrouted } = makeItinerary({
			nightsInConnection: 1
		});
		expect(rows(unrouted as Itinerary).map((row) => row.line)).toEqual([
			'Flights -> €118.00',
			'Hotel -> €20.00/night',
			'1 required night -> €20.00',
			'Rides from and to hotel -> not priced'
		]);
	});
});

describe('an estimated ground line (issue #249)', () => {
	function twoRatedTaxis(): Itinerary {
		return {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: ratedTaxi,
			transferToConnectionAirport: ratedTaxi
		};
	}

	it('prints the range on the row for the legs it covers, untinted and unlabelled', () => {
		// Untinted on purpose. The warning tint means "the total is short by this much and
		// nobody knows how much"; this row says how much, so wearing the same colour would
		// make a number the app has read as a hole it is confessing to.
		//
		// Issue #305 took the ESTIMATE tag off at the owner's request. A range with a dash in
		// it is already not a quote, and the row is named after the ride rather than after a
		// count, so the word was carrying nothing the two numbers did not.
		expect(rows(twoRatedTaxis()).map((row) => ({ ...row, line: row.line.replace(/\s+/g, ' ') }))).toEqual([
			{ line: 'Flights -> €118.00', missing: false },
			{ line: 'Hotel -> €20.00/night', missing: false },
			{ line: '1 required night -> €20.00', missing: false },
			{ line: 'Rides from and to hotel -> £48.52-£76.60', missing: false }
		]);
	});

	it('keeps the headline a floor, because the estimate is not inside it', () => {
		// The whole argument for the row existing at all. €138.00 is flights plus bed, and
		// the taxis are still outside it, so the number is still understating the trip.
		expect(headline(twoRatedTaxis())).toBe('from€138.00');
	});

	it('never adds the estimate to the total, even in one currency', () => {
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: {
				...taxi,
				fareEstimate: {
					kind: 'estimate' as const,
					currency: 'EUR' as const,
					lowMinorUnits: 1300,
					highMinorUnits: 1900,
					countryCode: 'ES' as const,
					rateSource: 'country' as const,
					citation: 'Barcelona municipal taxi tariff'
				}
			}
		};
		// The trip's own currency, so nothing would have thrown had somebody totalled it.
		// It is still out, because `results/sort.ts` orders cheapest-first on this figure
		// and `results/filters.ts` hides anything above the traveller's max price.
		expect(headline(trip)).toBe('from€138.00');
	});

	it('shows the rated ride and the unrated one as two different admissions', () => {
		// Issue #246's Gatwick run alongside a short hop. One row says roughly what it costs
		// and the other says nobody knows; collapsing them into "Ground, 2 rides not priced"
		// throws away the half the app has an answer for.
		const beyondTheCard: Transfer = {
			...taxi,
			fareEstimate: {
				kind: 'out-of-range',
				distanceKm: 94.9,
				ratedUpToKm: 30,
				countryCode: 'GB',
				citation: 'London black-cab Tariff 1'
			}
		};
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: ratedTaxi,
			transferToConnectionAirport: beyondTheCard
		};

		expect(rows(trip).map((row) => ({ ...row, line: row.line.replace(/\s+/g, ' ') }))).toEqual([
			{ line: 'Flights -> €118.00', missing: false },
			{ line: 'Hotel -> €20.00/night', missing: false },
			{ line: '1 required night -> €20.00', missing: false },
			{ line: 'Ride to hotel -> £24.26-£38.30', missing: false },
			{ line: 'Ride from hotel -> not priced', missing: true }
		]);
	});
});

describe("a converted ground line (issue #339)", () => {
	/** The owner's own reading, with the fix applied. A Birmingham ride whose rate card is
	 * written in sterling, on a trip he asked for in euros: the GBP figures are what
	 * `estimateTaxiFare` produces from the GB card, the EUR ones what they cross to. */
	const convertedTaxi: Transfer = {
		...taxi,
		fareEstimate: {
			kind: 'estimate',
			currency: 'EUR',
			lowMinorUnits: 4290,
			highMinorUnits: 6776,
			countryCode: 'GB',
			rateSource: 'country',
			citation: 'London black-cab Tariff 1',
			converted: {
				from: 'GBP',
				fromLowMinorUnits: 3686,
				fromHighMinorUnits: 5822,
				rateDate: '2026-09-04'
			}
		}
	};

	function convertedTrip(): Itinerary {
		return {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: convertedTaxi,
			transferToConnectionAirport: convertedTaxi
		};
	}

	/** The source line under a converted amount, per row, or `undefined` where there is
	 * none. */
	function sources(itinerary: Itinerary): (string | undefined)[] {
		return [...render(itinerary).querySelectorAll('.price-part')].map((row) =>
			row.querySelector('.price-part-source')?.textContent?.replace(/\s+/g, ' ').trim()
		);
	}

	it('prints the amount in the currency the traveller picked, not the ride\'s country\'s', () => {
		// The defect, verbatim from the issue: "Rides from and to hotel £115.04-£182.84 /
		// should be in euros or whatever currency i pick". This is the line that was wrong.
		expect(rows(convertedTrip()).map((row) => ({ ...row, line: row.line.replace(/\s+/g, ' ') }))).toEqual([
			{ line: 'Flights -> €118.00', missing: false },
			{ line: 'Hotel -> €20.00/night', missing: false },
			{ line: '1 required night -> €20.00', missing: false },
			{ line: 'Rides from and to hotel -> €85.80-€135.52', missing: false }
		]);
	});

	it('names the rate card\'s own range underneath, because that is what the driver charges', () => {
		// A bare euro figure reads as a quote. It is a rate card applied to a distance and
		// then crossed at a rate of some age, and the traveller pays the pounds.
		expect(sources(convertedTrip())).toEqual([undefined, undefined, undefined, 'from £73.72-£116.44']);
	});

	it('adds no source line to a row nothing converted', () => {
		// A Spanish ride for a euro trip is already in the traveller's currency, and "from
		// €X" under €X is noise dressed as provenance.
		expect(sources(twoRatedTaxisInEuros())).toEqual([undefined, undefined, undefined, undefined]);
	});

	it('keeps the headline a floor, because converting did not move the estimate into it', () => {
		// The load-bearing line of #292, unchanged by this issue. A converted guess is still
		// a guess, still outside `totalPrice`, and still not something `results/sort.ts` and
		// `results/filters.ts` get to decide a traveller's results with.
		expect(headline(convertedTrip())).toBe('from€138.00');
	});

	function twoRatedTaxisInEuros(): Itinerary {
		const spanish: Transfer = {
			...taxi,
			fareEstimate: {
				kind: 'estimate',
				currency: 'EUR',
				lowMinorUnits: 780,
				highMinorUnits: 975,
				countryCode: 'ES',
				rateSource: 'country',
				citation: 'Barcelona municipal taxi tariff'
			}
		};
		return {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: spanish,
			transferToConnectionAirport: spanish
		};
	}
});
