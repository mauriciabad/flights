import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { Airport, RoomKind, Stay } from '$lib/domain';
import StayPicker from './StayPicker.svelte';
import type { BedKind } from './room-kind';
import { groupByProperty } from './types';

/**
 * Issue #423's filter, through the DOM rather than through the pure functions under it.
 *
 * `rank.test.ts` and `choice.test.ts` already pin what the filter computes. What those
 * cannot see is the wiring: that a chip's click reaches the list at all, that the open card
 * keeps every room tile while the list narrows around it, and that the map is handed the
 * narrowed list rather than the whole one, which is the half of the owner's request
 * ("same on the map") that has no pure function of its own.
 *
 * Mounted with Svelte 5's own `mount`/`flushSync`, the way `StayAlternativeCard.test.ts`
 * does, because this project does not depend on @testing-library/svelte.
 */

const AIRPORT: Airport = {
	iataCode: 'VIE',
	name: 'Vienna Airport',
	coordinates: { latitude: 48.11, longitude: 16.57 },
	city: {
		name: 'Vienna',
		coordinates: { latitude: 48.2, longitude: 16.37 },
		country: { isoCode: 'AT', name: 'Austria' }
	},
	country: { isoCode: 'AT', name: 'Austria' },
	sizeClass: 'large'
};

function makeStay(name: string, roomKind: RoomKind, minorUnits: number): Stay {
	return {
		property: { name, coordinates: AIRPORT.coordinates, images: [] },
		roomKind,
		pricePerNight: { minorUnits, currency: 'EUR' }
	};
}

/** One hostel selling both kinds, one selling only dorms, one selling only rooms. The first
 * is the case a naive filter breaks: whichever chip is on, it belongs on the list. */
const MIXED_DORM = makeStay("Wombat's City Hostel", 'dorm', 1300);
const MIXED_ROOM = makeStay("Wombat's City Hostel", 'private', 4000);
const DORM_ONLY = makeStay('Hostel Ruthensteiner', 'dorm', 1100);
const ROOM_ONLY = makeStay('Hotel Post', 'private', 5200);

let target: HTMLElement | undefined;
let component: Record<string, unknown> | undefined;
/** Every write to the picked bed goes through `choose`, which always fires this. An empty
 * log is therefore proof that nothing the traveller did to the view moved their bed. */
let changes: Stay[] = [];

function render(candidates: Stay[], selected: Stay) {
	changes = [];
	target = document.createElement('div');
	document.body.appendChild(target);
	component = mount(StayPicker, {
		target,
		props: {
			properties: groupByProperty(candidates),
			connectionAirport: AIRPORT,
			nights: 2,
			selected,
			onchange: (stay: Stay) => changes.push(stay)
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

function chip(root: HTMLElement, label: BedKind): HTMLButtonElement {
	const wanted = label === 'dorm' ? 'Dorm bed' : 'Private room';
	const buttons = [...root.querySelectorAll<HTMLButtonElement>('.chip-row button')];
	const found = buttons.find((button) => button.textContent?.includes(wanted));
	if (!found) throw new Error(`no ${wanted} chip among ${buttons.map((b) => b.textContent?.trim())}`);
	return found;
}

function listedText(root: HTMLElement): string {
	return [...root.querySelectorAll('.stay-alternatives-list li')].map((li) => li.textContent ?? '').join(' ');
}

function listedCount(root: HTMLElement): number {
	return root.querySelectorAll('.stay-alternatives-list li').length;
}

function click(button: HTMLButtonElement) {
	button.click();
	flushSync();
}

describe('StayPicker bed-kind filter', () => {
	it('counts the properties behind each chip', () => {
		const root = render([MIXED_DORM, MIXED_ROOM, DORM_ONLY, ROOM_ONLY], MIXED_DORM);
		expect(chip(root, 'dorm').textContent).toContain('(2)');
		expect(chip(root, 'private').textContent).toContain('(2)');
	});

	it('keeps a property that sells both kinds and drops the one that does not', () => {
		const root = render([MIXED_DORM, MIXED_ROOM, DORM_ONLY, ROOM_ONLY], MIXED_DORM);
		expect(listedCount(root)).toBe(2);
		expect(listedText(root)).toContain('Hostel Ruthensteiner');

		click(chip(root, 'private'));

		expect(listedCount(root)).toBe(1);
		expect(listedText(root)).toContain('Hotel Post');
		expect(listedText(root)).not.toContain('Hostel Ruthensteiner');
	});

	// The map reads the same array as the list, so this is the whole of "same on the map":
	// the airport point plus the matching stays plus the one the trip books.
	it('hands the map the narrowed list', () => {
		const root = render([MIXED_DORM, MIXED_ROOM, DORM_ONLY, ROOM_ONLY], MIXED_DORM);
		expect(root.querySelector('.stay-map-open-label')?.textContent).toContain('all 3 stays');

		click(chip(root, 'private'));

		expect(root.querySelector('.stay-map-open-label')?.textContent).toContain('2 matching stays');
	});

	// Issue #27's dorm-and-private-prices-side-by-side is the picker's original acceptance
	// test, and a filter over the alternatives does not reverse it.
	it('leaves every room tile on the open card', () => {
		const root = render([MIXED_DORM, MIXED_ROOM, DORM_ONLY, ROOM_ONLY], MIXED_DORM);
		const tiles = () => root.querySelectorAll('.stay-room-kinds > *').length;
		expect(tiles()).toBe(2);

		click(chip(root, 'private'));

		expect(tiles()).toBe(2);
	});

	it('never moves the bed the trip books', () => {
		const root = render([MIXED_DORM, MIXED_ROOM, DORM_ONLY, ROOM_ONLY], MIXED_DORM);
		click(chip(root, 'private'));
		// A view filter is not a choice. Nothing fired `onchange`, and the card is still open
		// on the property the trip books rather than on the cheapest thing that matched.
		expect(changes).toEqual([]);
		expect(root.querySelector('.stay-picker')?.textContent).toContain("Wombat's City Hostel");
		expect(listedText(root)).not.toContain("Wombat's City Hostel");
	});

	it('says which kind found nothing, and offers one click back', () => {
		// The only private room here is the one on the open card, so the chip has inventory
		// behind it and is live, and choosing it still leaves the list with nothing on it.
		const root = render([MIXED_DORM, MIXED_ROOM, DORM_ONLY], MIXED_DORM);
		click(chip(root, 'private'));

		expect(listedCount(root)).toBe(0);
		expect(root.textContent).toContain('No other private room near this connection');

		const back = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
			button.textContent?.includes('Show every bed kind')
		);
		expect(back).toBeDefined();
		click(back as HTMLButtonElement);

		expect(listedCount(root)).toBe(1);
		expect(chip(root, 'private').getAttribute('aria-pressed')).toBe('false');
		expect(root.textContent).not.toContain('No other private room');
	});

	it('disables a chip with nothing behind it rather than hiding the question', () => {
		const root = render([MIXED_DORM, DORM_ONLY], MIXED_DORM);
		expect(chip(root, 'private').textContent).toContain('(0)');
		expect(chip(root, 'private').disabled).toBe(true);
	});
});
