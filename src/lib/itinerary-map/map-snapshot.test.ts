import { describe, expect, it } from 'vitest';
import { cameraForFrame, MAX_CAPTURE_ZOOM, snapshotKey, SUPERSAMPLE } from './map-snapshot.svelte';
import { mercatorY, projectToBox, type PreviewFrame } from './geo';

/**
 * The two halves of `map-snapshot.svelte.ts` that are arithmetic rather than WebGL.
 *
 * The capture itself is measured in a browser (`tests/e2e/route-previews.spec.ts`), since
 * jsdom has no WebGL and a mock of MapLibre would only ever confirm that the mock was
 * called. What is worth testing without a browser is whether the camera agrees with the
 * frame the route is drawn against, because a disagreement puts the roads and the route a
 * few hundred metres apart and nothing in the picture says so.
 */

const frameOf = (west: number, south: number, east: number, north: number): PreviewFrame => ({
	west,
	south,
	east,
	north
});

describe('cameraForFrame', () => {
	it('centres on the frame, in longitude and in real latitude', () => {
		const camera = cameraForFrame(frameOf(2, mercatorY(41), 2.1, mercatorY(41.1)), 120)!;
		expect(camera.center[0]).toBeCloseTo(2.05, 10);
		// The frame's vertical bounds are projected, so the centre latitude is the inverse
		// of their midpoint and sits slightly north of the plain average of 41.05.
		expect(camera.center[1]).toBeGreaterThan(41.05);
		expect(camera.center[1]).toBeLessThan(41.06);
	});

	it('picks the zoom that makes the box exactly as wide as the frame', () => {
		const camera = cameraForFrame(frameOf(2, 40, 2.1, 40.1), 120)!;
		// MapLibre's world is 512 * 2 ** zoom pixels across for 360 degrees of longitude,
		// so this is the definition read back: the box must cover the frame's own span.
		const degreesAcross = (120 * 360) / (512 * 2 ** camera.zoom);
		expect(degreesAcross).toBeCloseTo(0.1, 12);
	});

	it('halves the zoom step when the box doubles', () => {
		const frame = frameOf(2, 40, 2.1, 40.1);
		expect(cameraForFrame(frame, 240)!.zoom - cameraForFrame(frame, 120)!.zoom).toBeCloseTo(1, 12);
	});

	it('frames a real preview box so the drawing and the map cover the same rectangle', () => {
		// The path a ground preview actually takes: coordinates through `projectToBox`,
		// whose reported frame is what `RoutePreview` strokes the route against and what
		// this module hands MapLibre. The two have to agree by construction, not by luck.
		const shape = projectToBox(
			[
				[
					{ latitude: 41.2971, longitude: 2.0785 },
					{ latitude: 41.3851, longitude: 2.1734 }
				]
			],
			[],
			{ width: 120, height: 88, padding: 5 }
		);
		const camera = cameraForFrame(shape.frame, 120)!;
		const worldPixels = 512 * 2 ** camera.zoom;
		expect((shape.frame.east - shape.frame.west) * (worldPixels / 360)).toBeCloseTo(120, 6);
		// The same scale down the other axis, which is what makes one zoom enough: the box
		// is 88 tall and the frame's projected height must land on it.
		expect((shape.frame.north - shape.frame.south) * (worldPixels / 360)).toBeCloseTo(88, 6);
	});

	it('shows the same ground supersampled, one zoom step per doubling', () => {
		// The whole safety argument for drawing bigger than the box. The bounds are what
		// fixes the geography, so the centre may not move and the extra zoom must be exactly
		// what covers the same span across more pixels. Anything else and the route would be
		// stroked against a window the map is not showing.
		const frame = frameOf(2, mercatorY(41), 2.1, mercatorY(41.08));
		const box = cameraForFrame(frame, 120)!;
		const drawn = cameraForFrame(frame, 120 * SUPERSAMPLE)!;
		expect(drawn.center[0]).toBe(box.center[0]);
		expect(drawn.center[1]).toBe(box.center[1]);
		expect(drawn.zoom - box.zoom).toBeCloseTo(Math.log2(SUPERSAMPLE), 12);
	});

	it('keeps the tightest leg this app can draw clear of the zoom clamp', () => {
		// `MAX_CAPTURE_ZOOM` is a promise that MapLibre never clamps, because a clamped zoom
		// frames a window the route was not drawn against and nothing on the picture says
		// so. The tightest thing a ground leg can be is a walk of a few metres, so this
		// takes one metre, which is shorter than any journey, and checks it still fits.
		const oneMetreInDegrees = 1 / 111_320;
		const shape = projectToBox(
			[
				[
					{ latitude: 41.3851, longitude: 2.1734 },
					{ latitude: 41.3851, longitude: 2.1734 + oneMetreInDegrees }
				]
			],
			[],
			{ width: 120, height: 88, padding: 5 }
		);
		const camera = cameraForFrame(shape.frame, 120 * SUPERSAMPLE)!;
		expect(camera.zoom).toBeLessThan(MAX_CAPTURE_ZOOM);
	});

	it('has no camera for a frame with no width', () => {
		// `projectToBox` reports west === east for a leg that does not move. There is no
		// window to photograph and no zoom that would produce one.
		expect(cameraForFrame(frameOf(2, 40, 2, 40), 120)).toBeUndefined();
		expect(cameraForFrame(frameOf(2, 40, 2.1, 40.1), 0)).toBeUndefined();
	});
});

describe('snapshotKey', () => {
	it('gives one key to two cards looking at the same window', () => {
		const frame = frameOf(2.0785, 40.1, 2.1734, 40.2);
		expect(snapshotKey(frame, 120, 88, 2, 3, 'dark')).toBe(snapshotKey({ ...frame }, 120, 88, 2, 3, 'dark'));
	});

	it('separates the things that change the pixels', () => {
		const frame = frameOf(2.0785, 40.1, 2.1734, 40.2);
		const base = snapshotKey(frame, 120, 88, 2, 3, 'dark');
		expect(snapshotKey(frame, 120, 88, 2, 3, 'light')).not.toBe(base);
		expect(snapshotKey(frame, 240, 88, 2, 3, 'dark')).not.toBe(base);
		expect(snapshotKey(frame, 120, 176, 2, 3, 'dark')).not.toBe(base);
		expect(snapshotKey(frame, 120, 88, 1, 3, 'dark')).not.toBe(base);
		// The supersample decides how big a label is against the box, so it is pixels too.
		expect(snapshotKey(frame, 120, 88, 2, 2, 'dark')).not.toBe(base);
		expect(snapshotKey(frameOf(2.0785, 40.1, 2.1734, 40.3), 120, 88, 2, 3, 'dark')).not.toBe(base);
	});

	it('rounds the bounds, so two routes to the same window share a capture', () => {
		// A tenth of a micro-degree is a centimetre. Two itineraries whose arithmetic ends
		// a rounding step apart are looking at one place, and a key that told them apart
		// would capture the same picture once per card.
		const frame = frameOf(2.0785, 40.1, 2.1734, 40.2);
		const nudged = frameOf(2.0785 + 1e-9, 40.1, 2.1734, 40.2 - 1e-9);
		expect(snapshotKey(nudged, 120, 88, 2, 3, 'dark')).toBe(snapshotKey(frame, 120, 88, 2, 3, 'dark'));
	});
});
