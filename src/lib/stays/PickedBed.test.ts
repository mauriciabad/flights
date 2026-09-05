import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Property } from '../domain';
import PickedBed from './PickedBed.svelte';

/**
 * Issue #279. These mount the block and read it back off the DOM, the same way
 * `StopoverBlock.test.ts` does, because what the issue is about is what a person sees.
 *
 * The load discipline is the thing most worth pinning. Hostelworld serves 1 to 2.8 MB
 * originals with no resize (measured, `tools/probe-images.mjs`), so a strip that gives
 * every slide a `src` on render costs the reader 5 MB to look at one photograph. That is
 * invisible in a screenshot and invisible to a test that only asks whether an `<img>`
 * exists, so it is asserted here as the absence of a second `src`.
 *
 * Geometry is not asserted here and cannot be: jsdom has no layout, so every element is
 * 0x0 and an assertion about the reserved aspect box would pass against a broken one.
 * `tests/e2e/picked-bed.spec.ts` measures that in a real browser.
 */

let target: HTMLElement | undefined;
let component: Record<string, unknown> | undefined;

const PHOTO_A = 'https://fixture.invalid/photos/one.jpg';
const PHOTO_B = 'https://fixture.invalid/photos/two.jpg';

function property(overrides: Partial<Property> = {}): Property {
	return {
		name: "Wombat's City Hostel",
		coordinates: { latitude: 48.2, longitude: 16.35 },
		images: [PHOTO_A, PHOTO_B],
		rating: { value: 87, outOf: 100 },
		...overrides
	};
}

function render(props: Partial<Parameters<typeof PickedBed>[1]> = {}) {
	target = document.createElement('div');
	document.body.appendChild(target);
	component = mount(PickedBed, {
		target,
		props: {
			property: property(),
			roomKindLabel: 'Dorm bed',
			nights: 2,
			rate: { amount: '€13.00', audience: 'each' },
			distanceFromAirport: '2.9 km',
			transfer: { note: 'Bus, 30 min from the airport, €10.00 each way', mode: 'transit' },
			...props
		}
	});
	flushSync();
	giveTheStripAWidth();
	return target;
}

/**
 * jsdom runs no layout, so every element reports `clientWidth: 0`, and the component
 * rightly declines to scroll a strip with no width. That would leave the carousel inert in
 * every test below for a reason that has nothing to do with the carousel, so the strip is
 * handed the geometry a browser would give it. The number is arbitrary; only the component's
 * arithmetic against it is under test.
 */
const SLIDE_WIDTH = 100;
let stripScrollLeft = 0;

function giveTheStripAWidth() {
	const strip = target!.querySelector('.bed-strip');
	if (!strip) return;
	stripScrollLeft = 0;
	Object.defineProperty(strip, 'clientWidth', { value: SLIDE_WIDTH, configurable: true });
	Object.defineProperty(strip, 'scrollLeft', {
		get: () => stripScrollLeft,
		set: (value: number) => {
			stripScrollLeft = value;
		},
		configurable: true
	});
}

/** Moves the strip the way a reader's own swipe does, and tells the component about it. */
function scrollTheStripTo(offset: number) {
	stripScrollLeft = offset;
	target!.querySelector('.bed-strip')!.dispatchEvent(new Event('scroll'));
	flushSync();
}

const sources = () => [...target!.querySelectorAll('img')].map((img) => img.getAttribute('src'));
const counter = () => target!.querySelector('.bed-count')?.textContent?.trim();
const next = () => target!.querySelector<HTMLButtonElement>('.bed-arrow-next')!;
const prev = () => target!.querySelector<HTMLButtonElement>('.bed-arrow-prev')!;

/**
 * jsdom implements no scrolling at all, so `Element.scrollTo` is simply absent and the
 * component's call to it throws. Stubbing it here rather than guarding the call in the
 * component: the production code is right and the environment is incomplete, and a
 * `typeof x === 'function'` guard in shipped code to satisfy a test runner is a lie about
 * what browsers do.
 *
 * Recording the argument turns the workaround into an assertion. `clientWidth` is 0 in
 * jsdom so the offset is always 0, but whether the strip was told to move at all is real,
 * and it is the half of the carousel the counter cannot prove on its own.
 */
let scrolls: number[] = [];

beforeEach(() => {
	scrolls = [];
	Element.prototype.scrollTo = function (options?: ScrollToOptions | number) {
		scrolls.push(typeof options === 'object' && options ? (options.left ?? 0) : 0);
	} as Element['scrollTo'];
});

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

describe('the photographs, and what they cost to fetch', () => {
	it('gives only the first photograph a src, so the second is never fetched unasked', () => {
		// The 5 MB assertion. Hostelworld's originals run to 2.8 MB each and it has no
		// resize, so a second slide with a src is a second download nobody asked for.
		render();
		expect(sources()).toEqual([PHOTO_A]);
	});

	it('fetches the second only once the reader asks for it', () => {
		render();
		next().click();
		flushSync();
		expect(sources()).toEqual([PHOTO_A, PHOTO_B]);
		expect(counter()).toBe('2 / 2');
		// The strip was actually told to move, not just relabelled. A counter that counts
		// while the pictures stay put is the failure mode a text assertion cannot see.
		expect(scrolls).toHaveLength(1);
	});

	it('keeps the first loaded when the reader comes back, rather than refetching it', () => {
		render();
		next().click();
		flushSync();
		prev().click();
		flushSync();
		expect(sources()).toEqual([PHOTO_A, PHOTO_B]);
		expect(counter()).toBe('1 / 2');
	});

	it('ignores the strip while a programmatic scroll is still travelling', () => {
		// The flicker this prevents is visible and it was real. Paging back to photo 1 sets
		// the index at once, then the smooth scroll starts from the old offset and its first
		// events round back to photo 2. The counter flicked 1 to 2 to 1 and both arrows
		// flicked disabled with it, which was enough for a keyboard press to land on a
		// control that was briefly dead. jsdom has no layout, so the strip's geometry is
		// supplied here; the arithmetic under test is the component's own.
		render();
		next().click();
		flushSync();
		expect(counter()).toBe('2 / 2');

		// Mid-animation, still at the offset it started from. This must not drag the counter
		// back to where the reader has just left.
		scrollTheStripTo(0);
		expect(counter()).toBe('2 / 2');

		// Arrived. The strip is trusted again from here on.
		scrollTheStripTo(SLIDE_WIDTH);
		expect(counter()).toBe('2 / 2');

		// A swipe of the reader's own is honoured the moment it moves.
		scrollTheStripTo(0);
		expect(counter()).toBe('1 / 2');
	});

	it('has no controls at all for a single photograph, rather than dead ones', () => {
		// A greyed arrow is a promise the data cannot keep: Booking returns exactly one
		// image per property, so this is the common case, not the edge case.
		const el = render({ property: property({ images: [PHOTO_A] }) });
		expect(el.querySelector('.bed-arrow')).toBeNull();
		expect(el.querySelector('.bed-count')).toBeNull();
		expect(sources()).toEqual([PHOTO_A]);
	});

	it('draws no media box when the provider gave no photograph', () => {
		// Honest rather than apologetic: a grey rectangle with a building glyph says a
		// picture is missing, and nothing is missing.
		const el = render({ property: property({ images: [] }) });
		expect(el.querySelector('.bed-media')).toBeNull();
		expect(el.querySelector('img')).toBeNull();
		// The facts still stand on their own.
		expect(el.textContent).toContain("Wombat's City Hostel");
	});

	it('stops the arrows at the ends instead of wrapping round', () => {
		render();
		expect(prev().disabled).toBe(true);
		expect(next().disabled).toBe(false);
		next().click();
		flushSync();
		expect(prev().disabled).toBe(false);
		expect(next().disabled).toBe(true);
	});
});

describe('reaching the photographs from a keyboard', () => {
	it('moves with the arrow keys while a control has focus', () => {
		const el = render();
		next().focus();
		el.querySelector('.bed-media')!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
		);
		flushSync();
		expect(counter()).toBe('2 / 2');

		el.querySelector('.bed-media')!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
		);
		flushSync();
		expect(counter()).toBe('1 / 2');
	});

	it('leaves every other key to the browser', () => {
		// Tab in particular. Nothing in the strip is focusable and the arrows are ordinary
		// buttons, so a reader tabs straight out; swallowing keys here is what would build
		// the focus trap this carousel does not have.
		const el = render();
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		el.querySelector('.bed-media')!.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	it('names each photograph and its position for a screen reader', () => {
		render();
		expect(target!.querySelector('img')!.getAttribute('alt')).toBe(
			"Wombat's City Hostel, photo 1 of 2"
		);
		expect(target!.querySelector('.bed-media')!.getAttribute('aria-label')).toBe(
			"Photos of Wombat's City Hostel"
		);
		// The count changes on a swipe, which fires no event a screen reader reports.
		expect(target!.querySelector('.bed-count')!.getAttribute('aria-live')).toBe('polite');
	});

	it('drops the position from the alt text when there is only one photograph', () => {
		const el = render({ property: property({ images: [PHOTO_A] }) });
		expect(el.querySelector('img')!.getAttribute('alt')).toBe("Wombat's City Hostel");
	});
});

describe('a photograph that fails to load', () => {
	it('retries a Booking upgrade at the address the provider actually gave', () => {
		// `booking-mapper.ts` rewrites the 60x60 thumbnail to a card size measured against
		// three photo ids. A shape it guessed wrong about degrades to the thumbnail here,
		// so the worst case is what shipped before the upgrade rather than an empty box.
		const upgraded =
			'https://cf.bstatic.com/xdata/images/hotel/max1024x768/751028262.jpg?k=abc&o=';
		const el = render({ property: property({ images: [upgraded] }) });
		el.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		expect(sources()).toEqual([
			'https://cf.bstatic.com/xdata/images/hotel/square60/751028262.jpg?k=abc&o='
		]);
	});

	it('gives up rather than retrying forever once the fallback fails too', () => {
		const upgraded =
			'https://cf.bstatic.com/xdata/images/hotel/max1024x768/751028262.jpg?k=abc&o=';
		const el = render({ property: property({ images: [upgraded] }) });
		el.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		el.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		expect(el.querySelector('img')).toBeNull();
		// The box keeps its space, so nothing below it moves.
		expect(el.querySelector('.bed-media')).not.toBeNull();
	});

	it('has nothing to retry for a photograph no rewrite touched', () => {
		const el = render({ property: property({ images: [PHOTO_A] }) });
		el.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		expect(el.querySelector('img')).toBeNull();
	});
});
