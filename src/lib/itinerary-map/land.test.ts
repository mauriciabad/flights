import { describe, expect, it } from 'vitest';
import { mercatorY, projectToBox, type PreviewFrame, type ProjectedPoint } from './geo';
import { landPath } from './land';

const WIDTH = 120;
const HEIGHT = 92;
const BOX = { width: WIDTH, height: HEIGHT, padding: 5 };
const WHOLE_BOX = `M0 0L${WIDTH} 0L${WIDTH} ${HEIGHT}L0 ${HEIGHT}Z`;

/** A frame `halfSpan` degrees of longitude either side of a place, at the box's aspect. */
function frameAround(longitude: number, latitude: number, halfSpan: number): PreviewFrame {
	const halfHeight = (halfSpan * HEIGHT) / WIDTH;
	return {
		west: longitude - halfSpan,
		east: longitude + halfSpan,
		south: mercatorY(latitude) - halfHeight,
		north: mercatorY(latitude) + halfHeight
	};
}

/** Nothing to vouch for, so the ashore check has nothing to fail on. */
const NO_POINTS: ProjectedPoint[] = [];

describe('landPath: when a coast is drawn', () => {
	it('fills a ground-leg window solid rather than guessing where the coast runs', () => {
		// 0.1° either side of Barcelona airport is a 22 km window: about the taxi ride into
		// the city, and far narrower than the vendored outline's own 6.8 km of slack. A coast
		// drawn here would be a third of the picture out of place.
		expect(landPath(frameAround(2.078, 41.297, 0.1), WIDTH, HEIGHT, NO_POINTS)).toBe(WHOLE_BOX);
	});

	it('fills solid over open ocean too, so the refusal is a refusal and not a lookup', () => {
		expect(landPath(frameAround(-40, 25, 0.1), WIDTH, HEIGHT, NO_POINTS)).toBe(WHOLE_BOX);
	});

	it('fills solid for a journey that never moves, which has no rectangle at all', () => {
		const here = { latitude: 48.2, longitude: 16.37 };
		const { frame, points } = projectToBox([[here, here]], [here], BOX);

		expect(landPath(frame, WIDTH, HEIGHT, points)).toBe(WHOLE_BOX);
	});

	it('draws nothing in the middle of an ocean once the window is wide enough to mean it', () => {
		expect(landPath(frameAround(-40, 25, 8), WIDTH, HEIGHT, NO_POINTS)).toBe('');
	});

	it('fills the box over the middle of a continent', () => {
		const sahara = landPath(frameAround(10, 25, 5), WIDTH, HEIGHT, NO_POINTS);

		expect(sahara).not.toBe('');
		expect(sahara).toContain('M');
	});

	it('cuts a real coast when the window straddles one', () => {
		const lisbon = landPath(frameAround(-9.1, 38.7, 3), WIDTH, HEIGHT, NO_POINTS);

		expect(lisbon).not.toBe('');
		expect(lisbon).not.toBe(WHOLE_BOX);
	});

	it('keeps the island destinations this app sells', () => {
		// The reason the vendored outline comes from Natural Earth 1:10m and not the 1:110m
		// set every locator map reaches for first: 110m has no Cape Verde at all, and a BVC
		// itinerary would draw its origin dot on open Atlantic.
		expect(landPath(frameAround(-22.889, 16.137, 2.5), WIDTH, HEIGHT, NO_POINTS)).not.toBe('');
		expect(landPath(frameAround(32.486, 34.718, 2.5), WIDTH, HEIGHT, NO_POINTS)).not.toBe('');
	});

	it('finds land for a route written past the antimeridian', () => {
		// `singleFrame` hands out longitudes past 180 for a Pacific trip, while every ring is
		// stored in -180..180. Fiji at 178 has to be found again at 178 and at 538.
		const inFrame = landPath(frameAround(178, -17.8, 3), WIDTH, HEIGHT, NO_POINTS);
		const nextWorldOver = landPath(frameAround(538, -17.8, 3), WIDTH, HEIGHT, NO_POINTS);

		expect(inFrame).not.toBe('');
		expect(nextWorldOver).toBe(inFrame);
	});
});

describe('landPath: no dot may be left offshore', () => {
	const barcelona = { latitude: 41.2971, longitude: 2.0785 };
	const tallinn = { latitude: 59.4133, longitude: 24.8328 };

	it('draws the coast under a real flight, whose airports are both on it', () => {
		const { frame, points } = projectToBox([[barcelona, tallinn]], [barcelona, tallinn], BOX);
		const path = landPath(frame, WIDTH, HEIGHT, points);

		expect(path).not.toBe('');
		expect(path).not.toBe(WHOLE_BOX);
	});

	it('gives up the whole backdrop rather than draw a dot in the water', () => {
		// Nothing this app routes to sits here, which is the point: an airport the outline
		// has no land for is exactly the 1:10m gap that leaves 92 of them adrift, and a
		// window a thousand kilometres wide cannot see the problem on its own.
		const openSea: ProjectedPoint = { x: WIDTH / 2, y: HEIGHT / 2 };

		expect(landPath(frameAround(-30, 35, 10), WIDTH, HEIGHT, [openSea])).toBe(WHOLE_BOX);
	});

	it('lets a dot a stroke away from a simplified shore still count as ashore', () => {
		// A coastal airport lands a fraction of a pixel outside a simplified coast all the
		// time. Its dot is drawn at radius 3 in these units, so it overlaps the land it is
		// beside, and throwing the backdrop away for that would cost every coastal card its
		// geography.
		const sahara = frameAround(10, 25, 5);
		const inside = landPath(sahara, WIDTH, HEIGHT, [{ x: WIDTH / 2, y: HEIGHT / 2 }]);

		expect(inside).not.toBe(WHOLE_BOX);
		expect(inside).not.toBe('');
	});
});
