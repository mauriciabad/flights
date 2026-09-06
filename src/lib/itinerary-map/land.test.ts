import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mercatorY, projectToBox, type PreviewFrame, type ProjectedPoint } from './geo';
import { previewMap } from './land';
import { forgetLandTiles } from './land-tiles.svelte';

const WIDTH = 120;
const HEIGHT = 92;
const BOX = { width: WIDTH, height: HEIGHT, padding: 5 };
const WHOLE_BOX = `M0 0L${WIDTH} 0L${WIDTH} ${HEIGHT}L0 ${HEIGHT}Z`;

/**
 * The tiles are answered from `static/land/` rather than from a fixture, so these tests
 * measure the bytes that actually ship. A fixture here would prove that the decoder can
 * read something the encoder wrote, which is `coastline-codec.test.ts`'s job; what needs
 * proving is that the geography under a Barcelona taxi ride is Barcelona's.
 */
beforeAll(() => {
	vi.stubGlobal('fetch', async (input: string) => {
		const { pathname } = new URL(input, 'http://localhost');
		try {
			const body = readFileSync(path.join(process.cwd(), 'static', pathname), 'utf-8');
			return { ok: true, text: async () => body };
		} catch {
			return { ok: false, text: async () => '' };
		}
	});
});

afterEach(() => forgetLandTiles());

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

/** The land as one string, which is what every assertion below is about. Several paths
 *  only ever mean several tiles, and no test here cares which tile drew what. */
function land(frame: PreviewFrame, points: readonly ProjectedPoint[] = NO_POINTS): string {
	return previewMap(frame, WIDTH, HEIGHT, points).land.join('');
}

/** Waits for the region's tile to arrive, since a preview draws twice: the honest fill
 *  first, the real coast when the fetch lands. */
async function withTiles(frame: PreviewFrame, points: readonly ProjectedPoint[] = NO_POINTS) {
	return vi.waitFor(() => {
		const map = previewMap(frame, WIDTH, HEIGHT, points);
		expect(map.source).toBe('tiles');
		return map;
	});
}

describe('previewMap: which geometry answers', () => {
	it('fills a ground-leg window solid until its region has arrived', () => {
		// 0.1° either side of Barcelona airport is a 22 km window: about the taxi ride into
		// the city, and far narrower than the vendored outline's own 6.8 km of slack. The
		// tile that can answer it is still in flight on this first call, and the honest fill
		// is what a preview shows meanwhile — the same picture it showed before #408, for
		// the few hundred milliseconds it takes.
		expect(land(frameAround(2.078, 41.297, 0.1))).toBe(WHOLE_BOX);
	});

	it('shows the water beside a coastal airport once the region has arrived', async () => {
		// The whole of #408 in one assertion. This window is 22 km across and the sea is a
		// third of it; before this issue it was a grey box.
		const map = await withTiles(frameAround(2.078, 41.297, 0.1));

		expect(map.land.join('')).not.toBe(WHOLE_BOX);
		expect(map.land.join('')).not.toBe('');
	});

	it('fills an inland ground-leg window solid, and means it', async () => {
		// Madrid. The tile says this whole cell is land, so the fill is the answer rather
		// than the absence of one, and that distinction is the reason a cell with no coast
		// in it still gets a record.
		const map = await withTiles(frameAround(-3.57, 40.49, 0.1));

		expect(map.land.join('')).toContain('M');
		expect(map.borders).toBe('');
	});

	it('fills solid over open ocean too, so the refusal is a refusal and not a lookup', () => {
		expect(land(frameAround(-40, 25, 0.1))).toBe(WHOLE_BOX);
	});

	it('fills solid for a journey that never moves, which has no rectangle at all', () => {
		const here = { latitude: 48.2, longitude: 16.37 };
		const { frame, points } = projectToBox([[here, here]], [here], BOX);

		expect(land(frame, points)).toBe(WHOLE_BOX);
	});

	it('draws nothing in the middle of an ocean once the window is wide enough to mean it', () => {
		expect(land(frameAround(-40, 25, 8))).toBe('');
	});

	it('fills the box over the middle of a continent', () => {
		const sahara = land(frameAround(10, 25, 5));

		expect(sahara).not.toBe('');
		expect(sahara).toContain('M');
	});

	it('cuts a real coast when the window straddles one', () => {
		const lisbon = land(frameAround(-9.1, 38.7, 3));

		expect(lisbon).not.toBe('');
		expect(lisbon).not.toBe(WHOLE_BOX);
	});

	it('keeps the island destinations this app sells', () => {
		// The reason the vendored outline comes from Natural Earth 1:10m and not the 1:110m
		// set every locator map reaches for first: 110m has no Cape Verde at all, and a BVC
		// itinerary would draw its origin dot on open Atlantic.
		expect(land(frameAround(-22.889, 16.137, 2.5))).not.toBe('');
		expect(land(frameAround(32.486, 34.718, 2.5))).not.toBe('');
	});

	it('finds land for a route written past the antimeridian', () => {
		// `singleFrame` hands out longitudes past 180 for a Pacific trip, while every ring is
		// stored in -180..180. Fiji at 178 has to be found again at 178 and at 538.
		const inFrame = land(frameAround(178, -17.8, 3));
		const nextWorldOver = land(frameAround(538, -17.8, 3));

		expect(inFrame).not.toBe('');
		expect(nextWorldOver).toBe(inFrame);
	});

	it('reports which geometry it used, so a picture can be told from a fallback', () => {
		expect(previewMap(frameAround(-9.1, 38.7, 3), WIDTH, HEIGHT, NO_POINTS).source).toBe('outline');
		expect(previewMap(frameAround(-40, 25, 0.1), WIDTH, HEIGHT, NO_POINTS).source).toBe('solid');
	});
});

describe('previewMap: country boundaries', () => {
	it('draws the border a wide window crosses', () => {
		// The Pyrenees, across a window wide enough for the bundled boundary layer to place
		// one. The owner asked for this in #408: "I also expect the country boundaries to
		// show".
		const map = previewMap(frameAround(0.5, 42.6, 3), WIDTH, HEIGHT, NO_POINTS);

		expect(map.borders).not.toBe('');
		expect(map.borders.startsWith('M')).toBe(true);
	});

	it('never closes a boundary, because a boundary is not a shape', () => {
		const map = previewMap(frameAround(0.5, 42.6, 3), WIDTH, HEIGHT, NO_POINTS);

		expect(map.borders).not.toContain('Z');
	});

	it('withholds the bundled boundaries from a window too narrow to place them in', () => {
		// Geneva, 22 km across, with the tile still in flight. The bundled layer snaps to
		// 0.05° and would be 5.5 km wrong here, which is a quarter of the picture. Silence
		// is the right answer until the region's own copy arrives.
		expect(previewMap(frameAround(6.11, 46.23, 0.1), WIDTH, HEIGHT, NO_POINTS).borders).toBe('');
	});

	it('draws a border at ground-leg zoom once the region has arrived', async () => {
		// Geneva again. This is the case the fine copy inside the tiles exists for.
		const map = await withTiles(frameAround(6.1, 46.2, 0.15));

		expect(map.borders).not.toBe('');
	});

	it('says nothing about borders when it will not vouch for the land', () => {
		const openSea: ProjectedPoint = { x: WIDTH / 2, y: HEIGHT / 2 };

		expect(previewMap(frameAround(-30, 35, 10), WIDTH, HEIGHT, [openSea]).borders).toBe('');
	});
});

describe('previewMap: no dot may be left offshore', () => {
	const barcelona = { latitude: 41.2971, longitude: 2.0785 };
	const tallinn = { latitude: 59.4133, longitude: 24.8328 };

	it('draws the coast under a real flight, whose airports are both on it', () => {
		const { frame, points } = projectToBox([[barcelona, tallinn]], [barcelona, tallinn], BOX);
		const path = land(frame, points);

		expect(path).not.toBe('');
		expect(path).not.toBe(WHOLE_BOX);
	});

	it('gives up the whole backdrop rather than draw a dot in the water', () => {
		// Nothing this app routes to sits here, which is the point: an airport the outline
		// has no land for is exactly the 1:10m gap that leaves 92 of them adrift, and a
		// window a thousand kilometres wide cannot see the problem on its own.
		const openSea: ProjectedPoint = { x: WIDTH / 2, y: HEIGHT / 2 };

		expect(land(frameAround(-30, 35, 10), [openSea])).toBe(WHOLE_BOX);
	});

	it('gives up a tiled window too, so finer data is not a way past the guard', async () => {
		// Twelve kilometres out to sea off Barcelona, framed at ground-leg zoom. The tile
		// here is accurate to 62 m and this dot is still in the water, so the drawing goes
		// and the box fills. Finer geometry buys a better picture, never a lower bar.
		const frame = frameAround(2.2, 41.25, 0.1);
		await withTiles(frame);

		expect(previewMap(frame, WIDTH, HEIGHT, [{ x: WIDTH / 2, y: HEIGHT / 2 }]).land.join('')).toBe(
			WHOLE_BOX
		);
	});

	it('lets a dot a stroke away from a simplified shore still count as ashore', () => {
		// A coastal airport lands a fraction of a pixel outside a simplified coast all the
		// time. Its dot is drawn at radius 3 in these units, so it overlaps the land it is
		// beside, and throwing the backdrop away for that would cost every coastal card its
		// geography.
		const sahara = frameAround(10, 25, 5);
		const inside = land(sahara, [{ x: WIDTH / 2, y: HEIGHT / 2 }]);

		expect(inside).not.toBe(WHOLE_BOX);
		expect(inside).not.toBe('');
	});

	it('vouches for a dot inside a cell the tile calls land', async () => {
		// Madrid. A cell no coastline crosses contributes its own square, and the dot is
		// ashore by being inside it rather than by being near an edge of it — those edges
		// are where the data stops, not where the water starts, and they are marked so.
		const frame = frameAround(-3.57, 40.49, 0.1);
		await withTiles(frame);

		expect(previewMap(frame, WIDTH, HEIGHT, [{ x: WIDTH / 2, y: HEIGHT / 2 }]).source).toBe('tiles');
	});
});
