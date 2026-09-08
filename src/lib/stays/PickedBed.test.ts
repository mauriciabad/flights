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
 *
 * Issue #465 split the words the same way #458 split the pictures. What this block says is
 * the booking; what the stay picker's open card says is the property. So the cases below
 * assert the rating's absence rather than its wording, and `StayPicker.test.ts` is where the
 * rating and the distance are pinned now.
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
		expect(el.textContent).toContain('Bus, 30 min from the airport, €10.00 each way');
	});

	it("carries the room in the name's own line, so a long name and its room reflow together", () => {
		// Issue #465 took the row of chips away. A property name is a provider's free text and
		// some of them are very long, so the room has to wrap with the name rather than sit in
		// a block that leaves a chip stranded.
		const el = render();
		expect(el.querySelector('.bed-name')!.querySelector('.bed-tag')!.textContent!.trim()).toBe('Dorm bed');
	});

	it("scores nothing and measures nothing, because the picker's card does both (issue #465)", () => {
		// The property arrives with a rating and this block reads none of it. The picker's open
		// card, which is the same property by construction, prints "rated 8.7/10" and the
		// distance to the airport. A second copy of either a few centimetres above is the
		// duplication issue #309 named.
		const el = render({ property: property({ rating: { value: 87, outOf: 100 } }) });
		expect(el.textContent).not.toContain('8.7');
		expect(el.textContent).not.toContain('/10');
		expect(el.textContent).not.toContain('From airport');
	});

	it('says a property is women only, which no other surface shows', () => {
		const el = render({ property: property({ womenOnly: true }) });
		expect(el.textContent).toContain('Women only');
	});

	it('keeps the sentence about the ride when nothing routed to the bed at all', () => {
		const el = render({ transfer: { note: 'Nobody could route to this bed.' } });
		expect(el.textContent).toContain('Nobody could route to this bed.');
	});
});
