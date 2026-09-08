import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { Property } from '../domain';
import PickedBed from './PickedBed.svelte';

/**
 * Issue #279. These mount the block and read it back off the DOM, the same way
 * `StopoverBlock.test.ts` does, because what the issue is about is what a person sees.
 *
 * The carousel used to be pinned here too, because this block is where it was built. It
 * moved to `PhotoCarousel.test.ts` with issue #458, which is the component that has drawn
 * it since #307 lifted it out.
 */

let target: HTMLElement | undefined;
let component: Record<string, unknown> | undefined;

function property(overrides: Partial<Property> = {}): Property {
	return {
		name: "Wombat's City Hostel",
		coordinates: { latitude: 48.2, longitude: 16.35 },
		images: [],
		rating: { value: 87, outOf: 100 },
		...overrides
	};
}

function render(props: Partial<Parameters<typeof PickedBed>[1]> = {}) {
	target = document.createElement('div');
	document.body.appendChild(target);
	const shown = props.property ?? property();
	component = mount(PickedBed, {
		target,
		props: {
			property: shown,
			roomKindLabel: 'Dorm bed',
			nights: 2,
			rate: { amount: '€13.00', audience: 'each' },
			distanceFromAirport: '2.9 km',
			transfer: { note: 'Bus, 30 min from the airport, €10.00 each way', mode: 'transit' },
			...props
		}
	});
	flushSync();
	return target;
}

afterEach(() => {
	if (component) unmount(component);
	target?.remove();
	component = undefined;
	target = undefined;
});


describe('what the block says about the bed', () => {
	it('names the property, the room, the rate and who it covers, and the ride', () => {
		const el = render();
		expect(el.querySelector('.bed-name')!.textContent).toContain("Wombat's City Hostel");
		expect(el.querySelector('.bed-tag')!.textContent!.trim()).toBe('Dorm bed');
		expect(el.textContent).toContain('€13.00');
		expect(el.textContent).toContain('each');
		expect(el.textContent).toContain('2.9 km');
		expect(el.textContent).toContain('Bus, 30 min from the airport, €10.00 each way');
	});

	it('prints the rating through the one formatter, rescaled from the provider scale', () => {
		// Issue #258: Hostelworld's 87 is out of 100, and `formatPropertyRating` is the only
		// place that becomes a string. "87/5" reaching a reader is the defect that made the
		// scale part of the value in the first place.
		expect(render().querySelector('.bed-rating')!.textContent!.trim()).toBe('8.7/10');
	});

	it('draws no rating at all when no provider scored the property', () => {
		// Absent is a different fact from a bad score, so it is absent rather than zero.
		const el = render({ property: property({ rating: undefined }) });
		expect(el.querySelector('.bed-rating')).toBeNull();
	});

	it('says a property is women only, which no surface used to show', () => {
		const el = render({ property: property({ womenOnly: true }) });
		expect(el.textContent).toContain('Women only');
	});

	it('omits the distance rather than inventing one when no airport position was resolved', () => {
		const el = render({ distanceFromAirport: undefined });
		expect(el.textContent).not.toContain('From airport');
		// The ride is still there: it is a route, and it answers the question a different way.
		expect(el.textContent).toContain('Bus, 30 min from the airport');
	});

	it('keeps the sentence about the ride when nothing routed to the bed at all', () => {
		const el = render({ transfer: { note: 'Nobody could route to this bed.' } });
		expect(el.textContent).toContain('Nobody could route to this bed.');
	});
});
