import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { Airport, Property } from '$lib/domain';
import StayAlternativeCard from './StayAlternativeCard.svelte';
import { describeStayChoices } from './choice';
import type { PropertyStayOptions } from './types';

/**
 * Issue #281's fallback, exercised through the DOM rather than through the pure function
 * it calls. `agoda-photo.test.ts` already pins that the reverse direction returns the right
 * address; what could still be wrong is the wiring, and a card that quietly shows an empty
 * box is exactly the failure the fallback exists to prevent.
 *
 * Mounted with Svelte 5's own `mount`/`flushSync`, the way `StopoverBlock.test.ts` does,
 * because this project does not depend on @testing-library/svelte.
 */

const STORED = 'https://pix8.agoda.net/hotelImages/417108/0/c8efa945512ccad1b821cad1055e2d28.jpg?va=1&ce=3';
const RESIZED = `${STORED}&s=800x600`;

const AIRPORT: Airport = {
	iataCode: 'VIE',
	name: 'Vienna Airport',
	coordinates: { latitude: 48.11, longitude: 16.57 },
	city: { name: 'Vienna', coordinates: { latitude: 48.2, longitude: 16.37 }, country: { isoCode: 'AT', name: 'Austria' } },
	country: { isoCode: 'AT', name: 'Austria' },
	sizeClass: 'large'
};

let target: HTMLElement | undefined;
let component: Record<string, unknown> | undefined;

function renderImage(images: string[]): HTMLImageElement {
	const property: Property = { name: "Wombat's City Hostel", coordinates: AIRPORT.coordinates, images };
	const group: PropertyStayOptions = {
		options: [{ stay: { property, roomKind: 'dorm', pricePerNight: { minorUnits: 2946, currency: 'EUR' } } }]
	};
	const [choice] = describeStayChoices([group], {
		picked: group.options[0].stay,
		connectionAirport: AIRPORT.coordinates,
		cityCentre: AIRPORT.city.coordinates,
		nights: 1
	});
	target = document.createElement('div');
	document.body.appendChild(target);
	component = mount(StayAlternativeCard, {
		target,
		props: { choice, nights: 1, onselect: () => {} }
	});
	flushSync();
	return target.querySelector('img')!;
}

afterEach(() => {
	if (component) unmount(component);
	target?.remove();
	component = undefined;
	target = undefined;
});

describe('a photograph Agoda will not serve at the card size', () => {
	it('retries at the address Agoda published, and settles there', () => {
		const img = renderImage([RESIZED]);
		expect(img.src).toBe(RESIZED);

		img.dispatchEvent(new Event('error'));
		flushSync();
		expect(img.src).toBe(STORED);

		// The full-size photograph failing too must not send the card back to the resized
		// address it already knows is broken. One retry, then it stops.
		img.dispatchEvent(new Event('error'));
		flushSync();
		expect(img.src).toBe(STORED);
	});

	it('leaves an address it never resized exactly where it is', () => {
		const hostelworld = 'https://a.hwstatic.com/image/upload/propertyimages/5/527/x.jpg';
		const img = renderImage([hostelworld]);
		img.dispatchEvent(new Event('error'));
		flushSync();
		expect(img.src).toBe(hostelworld);
	});
});
