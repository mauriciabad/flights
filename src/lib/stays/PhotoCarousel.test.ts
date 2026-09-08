import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Property } from '../domain';
import PhotoCarousel from './PhotoCarousel.svelte';
import { stayPhotos, type StayPhoto } from './stay-photos';

/**
 * The carousel's own behaviour, mounted on its own.
 *
 * These cases were written for issue #283 against `PickedBed`, which is where the strip, the
 * arrows and the counter were built. Issue #307 lifted all of it into this component so the
 * picker's open card and the stay map's sidebar could show the same thing, and the tests
 * stayed behind. To learn how the carousel behaves you had to open the tests of one of the
 * three components that draw it, and the one that drew it first stopped drawing it at all
 * with issue #458.
 *
 * Nothing about the assertions changed in the move. What changed is what they mount.
 *
 * The load discipline is the thing most worth pinning, and it used to be worth megabytes.
 * Hostelworld publishes 1 to 2.8 MB originals, and issue #284 read that as an origin with
 * no resize. `hostelworld-photo.ts` now asks Cloudinary for the card width instead, so a
 * photograph costs about 65 KB. A second `src` on render is still a second download nobody
 * asked for, and it is still invisible in a screenshot and invisible to a test that only
 * asks whether an `<img>` exists, so it is asserted here as the absence of a second `src`.
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

/**
 * `photos` follows the property unless a case hands over its own. Issue #442 put the merge
 * of the building's photographs with the room's in `stayPhotos`, so this component is handed
 * a labelled list rather than reaching into `Property.images` itself, and every case below
 * that varies `images` still varies what the carousel draws.
 */
function render(props: { property?: Property; photos?: readonly StayPhoto[] } = {}) {
	target = document.createElement('div');
	document.body.appendChild(target);
	const shown = props.property ?? property();
	component = mount(PhotoCarousel, {
		target,
		props: { photos: props.photos ?? stayPhotos(shown), name: shown.name }
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
	const strip = target!.querySelector('.photo-strip');
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
	target!.querySelector('.photo-strip')!.dispatchEvent(new Event('scroll'));
	flushSync();
}

const sources = () => [...target!.querySelectorAll('img')].map((img) => img.getAttribute('src'));
const counter = () => target!.querySelector('.photo-count')?.textContent?.trim();
const next = () => target!.querySelector<HTMLButtonElement>('.photo-arrow-next')!;
const prev = () => target!.querySelector<HTMLButtonElement>('.photo-arrow-prev')!;

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

describe('the photographs, and what they cost to fetch', () => {
	it('gives only the first photograph a src, so the second is never fetched unasked', () => {
		// A second slide with a src is a second download nobody asked for. This used to be
		// the 5 MB assertion, back when #284 had every Hostelworld photograph at its
		// published size; `hostelworld-photo.ts` made it about 65 KB and kept it worth having.
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
		expect(el.querySelector('.photo-arrow')).toBeNull();
		expect(el.querySelector('.photo-count')).toBeNull();
		expect(sources()).toEqual([PHOTO_A]);
	});

	it('draws no media box when the provider gave no photograph', () => {
		// Honest rather than apologetic: a grey rectangle with a building glyph says a
		// picture is missing, and nothing is missing.
		const el = render({ property: property({ images: [] }) });
		expect(el.querySelector('.photo-carousel')).toBeNull();
		expect(el.querySelector('img')).toBeNull();
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
		el.querySelector('.photo-carousel')!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
		);
		flushSync();
		expect(counter()).toBe('2 / 2');

		el.querySelector('.photo-carousel')!.dispatchEvent(
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
		el.querySelector('.photo-carousel')!.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	it('names each photograph and its position for a screen reader', () => {
		render();
		expect(target!.querySelector('img')!.getAttribute('alt')).toBe("Wombat's City Hostel, photo 1 of 2");
		expect(target!.querySelector('.photo-carousel')!.getAttribute('aria-label')).toBe(
			"Photos of Wombat's City Hostel"
		);
		// The count changes on a swipe, which fires no event a screen reader reports.
		expect(target!.querySelector('.photo-count')!.getAttribute('aria-live')).toBe('polite');
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
		const upgraded = 'https://cf.bstatic.com/xdata/images/hotel/max1024x768/751028262.jpg?k=abc&o=';
		const el = render({ property: property({ images: [upgraded] }) });
		el.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		expect(sources()).toEqual(['https://cf.bstatic.com/xdata/images/hotel/square60/751028262.jpg?k=abc&o=']);
	});

	it('retries an Agoda resize at the address the provider actually gave', () => {
		// Issue #281 made Agoda the second provider whose URLs get rewritten, and the carousel
		// reaches the reverse through `original-photo.ts` rather than naming one of them.
		const stored =
			'https://pix8.agoda.net/hotelImages/417108/0/c8efa945512ccad1b821cad1055e2d28.jpg?va=1&ce=3';
		const el = render({ property: property({ images: [`${stored}&s=800x600`] }) });
		el.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		expect(sources()).toEqual([stored]);
	});

	it('gives up rather than retrying forever once the fallback fails too', () => {
		const upgraded = 'https://cf.bstatic.com/xdata/images/hotel/max1024x768/751028262.jpg?k=abc&o=';
		const el = render({ property: property({ images: [upgraded] }) });
		el.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		el.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		expect(el.querySelector('img')).toBeNull();
		// The box keeps its space, so nothing below it moves.
		expect(el.querySelector('.photo-carousel')).not.toBeNull();
	});

	it('has nothing to retry for a photograph no rewrite touched', () => {
		const el = render({ property: property({ images: [PHOTO_A] }) });
		el.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		expect(el.querySelector('img')).toBeNull();
	});
});

/**
 * Issue #441's wiring, and issue #442's labelling, from the photograph the owner clicks.
 *
 * What is NOT here is the zoom, and deliberately: jsdom runs no layout, so every rectangle is
 * 0x0 and an assertion about a transform would pass against a lightbox that cannot zoom at
 * all. `photo-zoom.test.ts` pins the arithmetic and `tools/probe-photo-lightbox.mjs` drives
 * the real thing in a real browser, which is where this repo has learned to look.
 */
describe('opening a photograph large', () => {
	const dialog = () => target!.querySelector('dialog');
	const expand = () => target!.querySelector<HTMLButtonElement>('.photo-expand')!;
	const roomBadge = () => target!.querySelector('.photo-subject')?.textContent?.trim();

	beforeEach(() => {
		// jsdom implements neither, and a dialog that throws on open takes the carousel with it.
		HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
			this.open = true;
		};
		HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
			this.open = false;
			this.dispatchEvent(new Event('close'));
		};
	});

	it('renders no dialog until the reader asks for one', () => {
		render();
		expect(dialog()).toBeNull();
	});

	it('opens on the photograph the reader was looking at, not on the first', () => {
		render();
		next().click();
		flushSync();
		expand().click();
		flushSync();
		expect(dialog()?.querySelector('.lightbox-count')?.textContent?.trim()).toContain('2 / 2');
	});

	it('pages with the arrow keys and closes with the close button', () => {
		render();
		expand().click();
		flushSync();
		dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(dialog()?.querySelector('.lightbox-count')?.textContent?.trim()).toContain('2 / 2');

		target!.querySelector<HTMLButtonElement>('.lightbox-close')!.click();
		flushSync();
		expect(dialog()).toBeNull();
	});

	it('says nothing about rooms when every photograph is of the building', () => {
		// Which is every property from every provider today. The chip is a claim, so it only
		// appears when there is something to claim.
		render();
		expect(roomBadge()).toBeUndefined();
		expand().click();
		flushSync();
		expect(target!.querySelector('.lightbox-subject')?.textContent?.trim()).toBe('Building');
	});

	it('asks for the published original only once the reader zooms past it', () => {
		// The byte promise, and the one claim `tools/probe-photo-lightbox.mjs` cannot make any
		// more: it serves its photographs from an origin of its own, and `originalStayPhoto`
		// only reverses an address on a provider's own host. jsdom runs no layout, which does
		// not matter here, because a zoom with no measurable box still raises the scale and the
		// scale is what decides this.
		const card =
			'https://a.hwstatic.com/image/upload/c_limit,w_800,f_auto,q_auto/v1/propertyimages/5/527/x.jpg';
		render({ photos: stayPhotos(property({ images: [card] }), []) });
		expand().click();
		flushSync();
		expect(target!.querySelector('.lightbox-full')).toBeNull();

		const stage = target!.querySelector('.lightbox-stage')!;
		stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
		flushSync();
		const full = target!.querySelector<HTMLImageElement>('.lightbox-full');
		// The address Hostelworld published, which is the 2.8 MB original the card-width rewrite
		// exists to avoid drawing until somebody asks to look closely.
		expect(full?.getAttribute('src')).toBe('https://a.hwstatic.com/propertyimages/5/527/x.jpg');
	});

	it('marks the room photograph as the room, on the strip and in the dialog', () => {
		const room = stayPhotos(property(), [
			{
				property: property(),
				roomKind: 'female-dorm',
				pricePerNight: { minorUnits: 1907, currency: 'EUR' },
				roomImages: ['https://fixture.invalid/photos/bunks.jpg']
			}
		]);
		render({ photos: room });
		next().click();
		flushSync();
		next().click();
		flushSync();
		expect(roomBadge()).toBe('Room');

		expand().click();
		flushSync();
		expect(target!.querySelector('.lightbox-subject')?.textContent?.trim()).toBe('Room');
		expect(target!.querySelector('.lightbox-caption')?.textContent).toContain(
			"Female-only dorm at Wombat's City Hostel"
		);
	});
});
