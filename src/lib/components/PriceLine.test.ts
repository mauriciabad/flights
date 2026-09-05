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

/** The same taxi, carrying what the GB rate card says a ride like it costs — the range
 * `providers/transfers/taxi-rate-table.ts` produces from an OSRM driving distance. Still no
 * `price`: this is a guess, and the row it produces has to read as one. */
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
			{ line: 'Bed, 1 night × €20.00 -> €20.00', missing: false },
			{ line: 'Ground, 1 walk -> free', missing: false },
			{ line: 'Ground, 3 rides -> not priced', missing: true }
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
			{ line: 'Bed, 1 night × €20.00 -> €20.00', missing: false },
			{ line: 'Ground, 2 walks -> free', missing: false }
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
			'Bed, 1 night × €20.00 -> €20.00',
			'Ground, 2 rides -> not priced'
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

	it('prints the range on its own row, tagged as an estimate and untinted', () => {
		// Untinted on purpose. The warning tint means "the total is short by this much and
		// nobody knows how much"; this row says how much, so wearing the same colour would
		// make a number the app has read as a hole it is confessing to.
		expect(rows(twoRatedTaxis()).map((row) => ({ ...row, line: row.line.replace(/\s+/g, ' ') }))).toEqual([
			{ line: 'Flights -> €118.00', missing: false },
			{ line: 'Bed, 1 night × €20.00 -> €20.00', missing: false },
			{ line: 'Ground, 2 rides -> £48.52-£76.60 estimate', missing: false }
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
			{ line: 'Bed, 1 night × €20.00 -> €20.00', missing: false },
			{ line: 'Ground, 1 ride -> £24.26-£38.30 estimate', missing: false },
			{ line: 'Ground, 1 ride -> not priced', missing: true }
		]);
	});
});
