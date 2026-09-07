import { describe, expect, it } from 'vitest';
import {
	NO_ZOOM,
	TAP_ZOOM_SCALE,
	clampPan,
	panBy,
	toggleZoom,
	wheelZoomFactor,
	zoomAt,
	type ZoomBox
} from './photo-zoom';

/**
 * A 1000x600 viewport holding an 800x600 photograph, so the drawn image touches the top and
 * bottom and leaves a 100px bar either side. That asymmetry is the point: it is what
 * separates clamping against the box from clamping against the picture, and a square test
 * box would pass either way.
 */
const BOX: ZoomBox = { width: 1000, height: 600, contentWidth: 800, contentHeight: 600 };

describe('clampPan', () => {
	it('pins an unzoomed photograph exactly where the layout put it', () => {
		// At scale 1 the drawn image is smaller than the box across and equal to it down, so
		// there is nothing to pan into on either axis.
		expect(clampPan({ scale: 1, x: 200, y: -80 }, BOX)).toEqual({ scale: 1, x: 0, y: 0 });
	});

	it('lets the photograph move exactly as far as its own edge', () => {
		// At scale 2 the drawn image is 1600x1200 in a 1000x600 box, so 300 across and 300 down.
		expect(clampPan({ scale: 2, x: 999, y: -999 }, BOX)).toEqual({ scale: 2, x: 300, y: -300 });
	});

	it('refuses a scale below rest and above the ceiling', () => {
		expect(clampPan({ scale: 0.2, x: 0, y: 0 }, BOX).scale).toBe(1);
		expect(clampPan({ scale: 50, x: 0, y: 0 }, BOX).scale).toBe(6);
	});
});

describe('zoomAt', () => {
	it('keeps the point under the pointer under the pointer', () => {
		// The whole feature. The image point at the pointer is (p - x) / scale; after the
		// zoom, x' + scale' * q has to land back on p.
		const pointer = { x: 300, y: -120 };
		const before = { scale: 1.5, x: 40, y: 10 };
		const after = zoomAt(before, BOX, pointer, 1.6);
		const q = (p: number, pan: number, scale: number) => (p - pan) / scale;
		expect(q(pointer.x, before.x, before.scale)).toBeCloseTo(q(pointer.x, after.x, after.scale), 6);
		expect(q(pointer.y, before.y, before.scale)).toBeCloseTo(q(pointer.y, after.y, after.scale), 6);
	});

	it('zooms about the pointer rather than the middle', () => {
		// Anchored at the middle this would stay at x: 0, which is the bug the issue names.
		const after = zoomAt(NO_ZOOM, BOX, { x: 200, y: 0 }, 2);
		expect(after.x).toBeLessThan(0);
	});

	it('comes back to rest when it zooms back out', () => {
		const zoomed = zoomAt(NO_ZOOM, BOX, { x: 250, y: 90 }, 3);
		expect(zoomAt(zoomed, BOX, { x: 250, y: 90 }, 1 / 3)).toEqual(NO_ZOOM);
	});

	it('never lets an edge inside the box', () => {
		// Anchoring alone would push the photograph's own edge into view at the far corner.
		const after = zoomAt(NO_ZOOM, BOX, { x: 500, y: 300 }, 2);
		expect(Math.abs(after.x)).toBeLessThanOrEqual(300);
		expect(Math.abs(after.y)).toBeLessThanOrEqual(300);
	});

	it('leaves the pan alone for a factor that is not a number it can use', () => {
		expect(zoomAt(NO_ZOOM, BOX, { x: 0, y: 0 }, Number.NaN)).toEqual(NO_ZOOM);
		expect(zoomAt(NO_ZOOM, BOX, { x: 0, y: 0 }, 0)).toEqual(NO_ZOOM);
	});

	it('produces no NaN when nothing has decoded yet', () => {
		const empty: ZoomBox = { width: 0, height: 0, contentWidth: 0, contentHeight: 0 };
		const after = zoomAt(NO_ZOOM, empty, { x: 0, y: 0 }, 2);
		expect(Number.isFinite(after.x)).toBe(true);
		expect(Number.isFinite(after.y)).toBe(true);
	});
});

describe('panBy', () => {
	it('drags within the photograph and stops at its edge', () => {
		const zoomed = { scale: 2, x: 0, y: 0 };
		expect(panBy(zoomed, BOX, 120, -50)).toEqual({ scale: 2, x: 120, y: -50 });
		expect(panBy(zoomed, BOX, 4000, 0).x).toBe(300);
	});

	it('cannot move a photograph that is not zoomed', () => {
		expect(panBy(NO_ZOOM, BOX, 300, 300)).toEqual(NO_ZOOM);
	});
});

describe('toggleZoom', () => {
	it('goes in at the tap when it is at rest', () => {
		const after = toggleZoom(NO_ZOOM, BOX, { x: -200, y: 100 });
		expect(after.scale).toBe(TAP_ZOOM_SCALE);
		expect(after.x).toBeGreaterThan(0);
	});

	it('goes all the way out from anywhere zoomed', () => {
		expect(toggleZoom({ scale: 4, x: 200, y: 100 }, BOX, { x: 0, y: 0 })).toEqual(NO_ZOOM);
	});
});

describe('wheelZoomFactor', () => {
	it('zooms in when the wheel goes up and out when it goes down', () => {
		expect(wheelZoomFactor({ deltaY: -100 })).toBeGreaterThan(1);
		expect(wheelZoomFactor({ deltaY: 100 })).toBeLessThan(1);
	});

	it('answers a trackpad pinch far harder than a mouse wheel', () => {
		// A pinch reaches the page as a ctrl-wheel with a small delta. Matching the mouse
		// response to it is what makes a pinch feel like nothing is happening.
		const pinch = wheelZoomFactor({ deltaY: -10, ctrlKey: true });
		const wheel = wheelZoomFactor({ deltaY: -10 });
		expect(pinch).toBeGreaterThan(wheel);
		expect(pinch - 1).toBeGreaterThan((wheel - 1) * 4);
	});

	it('undoes itself exactly, so a scroll back lands where it started', () => {
		expect(wheelZoomFactor({ deltaY: -120 }) * wheelZoomFactor({ deltaY: 120 })).toBeCloseTo(1, 12);
	});

	it('reads a notch in lines as further than a notch in pixels', () => {
		// Firefox reports `deltaMode: 1` with a deltaY of 3, which is three LINES. Read as
		// pixels that is a three-pixel nudge and the wheel does nothing there.
		expect(wheelZoomFactor({ deltaY: -3, deltaMode: 1 })).toBeGreaterThan(
			wheelZoomFactor({ deltaY: -3, deltaMode: 0 })
		);
	});

	it('changes nothing for a delta that is not a number', () => {
		expect(wheelZoomFactor({ deltaY: Number.NaN })).toBe(1);
	});
});
