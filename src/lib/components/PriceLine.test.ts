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
