import { describe, expect, it } from 'vitest';
import { minimalScrollDelta } from './reveal-scroll';

/**
 * Issue #308's arithmetic, on its own.
 *
 * The defect was never in the scrolling: it was that #278 had no way to say "only if
 * something is covering it", so it inflated the target's box by a sheet's whole height and
 * `scrollIntoView({ block: 'nearest' })` obligingly moved the page every single time. These
 * cases are the ones the owner and the issue name, stated as numbers.
 */

const viewport = { top: 0, bottom: 800 };

describe('minimalScrollDelta', () => {
	it('does not move a target that is already fully in view', () => {
		// The whole issue. On a desktop, where the customise panel is a sidebar covering
		// nothing, this is every tap.
		expect(minimalScrollDelta({ top: 100, bottom: 200 }, viewport)).toBe(0);
	});

	it('does not move a target that ends exactly on the edge', () => {
		expect(minimalScrollDelta({ top: 700, bottom: 800 }, viewport)).toBe(0);
	});

	it('moves by exactly what is hidden, and no more', () => {
		// 30px below the fold means 30px of scroll, not "centre it" and not "top of screen".
		expect(minimalScrollDelta({ top: 750, bottom: 830 }, viewport)).toBe(30);
	});

	it('treats a covered viewport as a shorter one', () => {
		// A phone with the customise sheet up: the same target that needed nothing above now
		// needs 100px, because 300px of the screen is under the sheet.
		const covered = { top: 0, bottom: 500 };
		expect(minimalScrollDelta({ top: 100, bottom: 200 }, covered)).toBe(0);
		expect(minimalScrollDelta({ top: 500, bottom: 600 }, covered)).toBe(100);
	});

	it('never pushes a target off the top to reveal its bottom', () => {
		// A block taller than the space it has to fit in. Showing its top and letting the rest
		// run under the sheet beats showing its bottom and losing where it starts.
		expect(minimalScrollDelta({ top: 50, bottom: 900 }, viewport)).toBe(50);
	});

	it('scrolls back up for a target above the viewport, by the gap and nothing else', () => {
		expect(minimalScrollDelta({ top: -40, bottom: 60 }, viewport)).toBe(-40);
	});

	it('does not scroll down for a target that starts above the viewport and runs past it', () => {
		// Its top is already off screen. Moving down would hide more of it to reveal a bottom
		// that still would not fit.
		expect(minimalScrollDelta({ top: -100, bottom: 900 }, viewport)).toBe(0);
	});

	it('measures against a scroller that does not start at the top of the window', () => {
		// `.app-content` sits under the app header, so its own box is what a target has to be
		// inside, not the window's.
		const underHeader = { top: 49, bottom: 812 };
		expect(minimalScrollDelta({ top: 20, bottom: 120 }, underHeader)).toBe(-29);
		expect(minimalScrollDelta({ top: 60, bottom: 120 }, underHeader)).toBe(0);
	});
});
