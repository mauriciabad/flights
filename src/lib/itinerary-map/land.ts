/**
 * The map under a frozen preview: land, water and country boundaries (issues #346, #408).
 *
 * The owner asked for this three times. In #305, of the flight ornament: "i expect tat it
 * shows the sea white (same as bg in parent element) and land a but gray (current gray is
 * fine)". Then in #346, of everything: "in the flight map, the re's no map, it just shwos
 * the lines, same fot he other ground travels". Then in #408, of what #346 shipped: "the
 * inerte Maps don't show the water and land in different colors, they are a solid gray
 * always (in some searches they work). I also expect the country boundaries to show, and
 * the ground transport to show more details because they are zoomed in."
 *
 * So: filled paths under the arcs, in the grey the previews already used, on a background
 * that is whatever the parent element's is, and a boundary drawn as a gap in the land
 * rather than a mark on it. No tiles, no labels, no second colour, and above all no WebGL
 * — #280 measured four MapLibre instances per card settling in 4.5 s and twenty never
 * settling at all, and that has to stay true.
 *
 * ## When a coast is drawn, and when the box is simply filled
 *
 * Every dot on these drawings is an airport, a hotel or a city centre, so every one of
 * them is ashore. That is the fact this file defends: a backdrop that puts the traveller's
 * own origin in open water is worse than no backdrop at all, and it is the failure both
 * ways of getting this wrong end in.
 *
 * Two things can cause it, and they need different answers.
 *
 * **The coast is in roughly the wrong place.** Simplification moves it, and how far is
 * measured by whichever script wrote the geometry, against the geometry it actually wrote.
 * A window has to be `DISPLACEMENT_MULTIPLE` times that error before a coast is worth
 * drawing into it.
 *
 * **The land is not there at all.** 1:10m has no Niuatoputapu and no Wallis, and the
 * simplifier shrinks a small island away from an airport near its shore. A window
 * threshold cannot see this: the window can be a thousand kilometres wide and the origin
 * dot still floating. So the drawing is checked against the thing it must not do, by
 * asking whether every dot the preview places would read as ashore on the land actually
 * drawn.
 *
 * Failing either, the box is filled solid as land. That is not a guess. It says "somewhere
 * on land", which is the most this data can say there, and it is true.
 *
 * ## Two sources, one rule
 *
 * #346 shipped one outline and one threshold, and the threshold came out at 81.6 km. Every
 * ground leg is an airport-to-hotel hop of a few kilometres, so every ground preview was a
 * solid box, every time — which is what the owner is describing in #408 and it was working
 * as designed. Its header closed with the reason: "coastline fine enough for a 20 km
 * window is the whole world's inhabited shore at 1 km, 218 kB gzipped, on an app with no
 * backend."
 *
 * That measurement holds. What it assumed is that the world's shore had to be shipped
 * whole or not at all. `land-tiles.svelte.ts` fetches the 389 bytes of it a ground leg's
 * own window needs, from a static file, which is not a backend.
 *
 * So there are two sources of different accuracy, and one rule chooses between them:
 * coarsest first, and a source is eligible when the window spans `DISPLACEMENT_MULTIPLE`
 * times its own measured error. The flight ornament takes the bundled outline and never
 * fetches anything. A ground leg takes a tile. A window narrower than the finest source
 * can place a coast in, or one whose tiles have not arrived yet, still gets the solid box.
 *
 * Neither component knows about any of this. The picture decides for itself.
 */

import { COASTLINE_DISPLACEMENT_KM, COASTLINE_GRID_DEGREES, COASTLINE_RINGS } from '$lib/data/coastline.generated';
import {
	BOUNDARY_DISPLACEMENT_KM,
	BOUNDARY_GRID_DEGREES,
	BOUNDARY_LINES
} from '$lib/data/boundaries.generated';
import { LAND_TILE_DISPLACEMENT_KM } from '$lib/data/land-tiles.generated';
import { decodeRing, RING_SEPARATOR } from './coastline-codec';
import { landCell } from './land-tiles.svelte';
import { inverseMercatorY, mercatorY, type PreviewFrame, type ProjectedPoint } from './geo';

/**
 * How many times a source's own placement error a window must span before that source is
 * worth drawing into it.
 *
 * Twelve, so a coast is at worst a twelfth of the picture out of place: 9 px on a 104 px
 * preview, which reads as a soft shore rather than a wrong one.
 *
 * Each displacement is measured by the script that writes the geometry, against the
 * geometry it actually wrote. It is not the simplifier's tolerance and the two differ by a
 * factor of four; reading this threshold off the tolerance made it that much more timid
 * than it needed to be, and hand-copying a measured figure into this file would have gone
 * quietly wrong the first time anyone reran a script.
 */
const DISPLACEMENT_MULTIPLE = 12;

/** 81.6 km with the outline that ships today. */
const MIN_OUTLINE_WINDOW_KM = COASTLINE_DISPLACEMENT_KM * DISPLACEMENT_MULTIPLE;
/** 0.74 km with the tiles that ship today, which every ground leg clears. */
const MIN_TILE_WINDOW_KM = LAND_TILE_DISPLACEMENT_KM * DISPLACEMENT_MULTIPLE;
/** 69.6 km with the bundled boundaries, so they appear on a flight preview and never on a
 *  ground one, where the fine copy inside the tiles answers instead. */
const MIN_BOUNDARY_WINDOW_KM = BOUNDARY_DISPLACEMENT_KM * DISPLACEMENT_MULTIPLE;

/**
 * How close to the drawn land a dot may sit and still read as being on it, in box units.
 *
 * The dots are drawn at radius 3 in these same units, so a dot within 3 of the shore
 * overlaps it and nobody would call it offshore. Without this, a coastal airport a pixel
 * outside a simplified coast would throw away the whole backdrop for its card.
 */
const ASHORE_TOLERANCE = 3;

const KM_PER_DEGREE_LONGITUDE = 111.32;

/** One closed ring, already in the units `projectToBox` works in: longitude by
 *  `mercatorY`, so the per-vertex trig is paid once for the session and not once per
 *  card. */
interface LandRing {
	/** Alternating longitude and Mercator-projected latitude. */
	readonly points: Float64Array;
	readonly west: number;
	readonly east: number;
	readonly south: number;
	readonly north: number;
}

/**
 * Land that shares one `<path>`, and therefore one even-odd fill.
 *
 * The grouping is the whole correctness question here. Rings from one source have to be
 * painted together, because Natural Earth marks a lake as a ring inside the land ring and
 * even-odd is what cuts it back out — split them into separate paths and every lake in
 * Europe fills in as ground. Rings from *different* tiles have to be painted apart,
 * because neighbouring tiles overlap by design and even-odd across the seam would cancel
 * the overlap to sea. So: one group per source, and for tiles one group per cell.
 *
 * `shore` is the difference between an edge that is a coast and an edge that is only where
 * the data stopped. A cell with no coastline in it contributes its own square, whose four
 * edges are the latter, and letting a dot count as ashore because it sits near one would
 * quietly disarm the guard this whole file exists to keep armed.
 */
interface LandGroup {
	readonly polygons: readonly (readonly number[])[];
	readonly shore: boolean;
}

export interface PreviewMap {
	/**
	 * One `d` per `<path fill-rule="evenodd">`. More than one when a window straddles
	 * cells, and they must stay separate: neighbouring tiles overlap on purpose, and two
	 * overlapping rings in a single even-odd path cancel each other to sea along the seam.
	 * Drawn as separate opaque paths they union instead, which is what overlap is for.
	 */
	readonly land: readonly string[];
	/** Country boundaries inside the window, as one stroked path. Empty when there are
	 *  none, or when the geometry in hand cannot place one at this scale. */
	readonly borders: string;
	/** Which data answered. Read by tests and by nothing that draws. */
	readonly source: 'outline' | 'tiles' | 'solid';
}

let decodedRings: LandRing[] | undefined;

function landRings(): LandRing[] {
	if (decodedRings) return decodedRings;
	decodedRings = COASTLINE_RINGS.split(RING_SEPARATOR).map((encoded) => {
		const steps = decodeRing(encoded);
		const points = new Float64Array(steps.length);
		let west = Infinity;
		let east = -Infinity;
		let south = Infinity;
		let north = -Infinity;
		for (let i = 0; i < steps.length; i += 2) {
			const longitude = steps[i] * COASTLINE_GRID_DEGREES;
			const y = mercatorY(steps[i + 1] * COASTLINE_GRID_DEGREES);
			points[i] = longitude;
			points[i + 1] = y;
			if (longitude < west) west = longitude;
			if (longitude > east) east = longitude;
			if (y < south) south = y;
			if (y > north) north = y;
		}
		return { points, west, east, south, north };
	});
	return decodedRings;
}

/** One boundary, with the bounds that let a preview skip it without walking it. The
 *  world's admin-0 boundaries are 242 lines and a flight preview holds one country or two,
 *  so the bounds are what stops every card clipping all of them. */
interface BoundaryLine {
	readonly points: Float64Array;
	readonly west: number;
	readonly east: number;
	readonly south: number;
	readonly north: number;
}

let decodedBoundaries: BoundaryLine[] | undefined;

function boundaryLines(): BoundaryLine[] {
	if (decodedBoundaries) return decodedBoundaries;
	decodedBoundaries = BOUNDARY_LINES.split(RING_SEPARATOR).map((encoded) => {
		const steps = decodeRing(encoded);
		const points = new Float64Array(steps.length);
		let west = Infinity;
		let east = -Infinity;
		let south = Infinity;
		let north = -Infinity;
		for (let i = 0; i < steps.length; i += 2) {
			const longitude = steps[i] * BOUNDARY_GRID_DEGREES;
			const y = mercatorY(steps[i + 1] * BOUNDARY_GRID_DEGREES);
			points[i] = longitude;
			points[i + 1] = y;
			if (longitude < west) west = longitude;
			if (longitude > east) east = longitude;
			if (y < south) south = y;
			if (y > north) north = y;
		}
		return { points, west, east, south, north };
	});
	return decodedBoundaries;
}

function insideEdge(value: number, limit: number, keepBelow: boolean): boolean {
	return keepBelow ? value <= limit : value >= limit;
}

/**
 * Sutherland-Hodgman against one axis-aligned edge of the box.
 *
 * The classic algorithm, and the classic caveat with it: clipping a concave shape against
 * a rectangle can leave two separate pieces joined by an edge that runs along the
 * rectangle's border. That is invisible in a fill, which is all this is ever used for.
 */
function clipEdge(polygon: readonly number[], axis: 0 | 1, limit: number, keepBelow: boolean): number[] {
	const kept: number[] = [];
	const count = polygon.length / 2;
	if (count === 0) return kept;

	let previousX = polygon[(count - 1) * 2];
	let previousY = polygon[(count - 1) * 2 + 1];
	let previousValue = axis === 0 ? previousX : previousY;
	let previousInside = insideEdge(previousValue, limit, keepBelow);

	for (let i = 0; i < count; i++) {
		const x = polygon[i * 2];
		const y = polygon[i * 2 + 1];
		const value = axis === 0 ? x : y;
		const inside = insideEdge(value, limit, keepBelow);
		if (inside !== previousInside) {
			const t = (limit - previousValue) / (value - previousValue);
			kept.push(previousX + (x - previousX) * t, previousY + (y - previousY) * t);
		}
		if (inside) kept.push(x, y);
		previousX = x;
		previousY = y;
		previousValue = value;
		previousInside = inside;
	}
	return kept;
}

function clipToBox(polygon: readonly number[], width: number, height: number): number[] {
	let clipped = clipEdge(polygon, 0, 0, false);
	if (clipped.length === 0) return clipped;
	clipped = clipEdge(clipped, 0, width, true);
	if (clipped.length === 0) return clipped;
	clipped = clipEdge(clipped, 1, 0, false);
	if (clipped.length === 0) return clipped;
	return clipEdge(clipped, 1, height, true);
}

/**
 * Clips an open polyline to the box, returning the pieces that survive.
 *
 * Pieces rather than one array, which is the whole difference from clipping a ring. A
 * border leaving the box and coming back has two runs inside it, and joining them draws a
 * straight line across the gap — an invented border, on a drawing whose one unbreakable
 * rule is that it invents no lines.
 */
function clipLineToBox(line: readonly number[], width: number, height: number): number[][] {
	let pieces: number[][] = [line as number[]];
	const edges: [0 | 1, number, boolean][] = [
		[0, 0, false],
		[0, width, true],
		[1, 0, false],
		[1, height, true]
	];
	for (const [axis, limit, keepBelow] of edges) {
		const next: number[][] = [];
		for (const piece of pieces) {
			const count = piece.length / 2;
			if (count < 2) continue;
			let run: number[] = [];
			let previousX = piece[0];
			let previousY = piece[1];
			let previousInside = insideEdge(axis === 0 ? previousX : previousY, limit, keepBelow);
			if (previousInside) run.push(previousX, previousY);
			for (let i = 1; i < count; i++) {
				const x = piece[i * 2];
				const y = piece[i * 2 + 1];
				const inside = insideEdge(axis === 0 ? x : y, limit, keepBelow);
				if (inside !== previousInside) {
					const previousValue = axis === 0 ? previousX : previousY;
					const value = axis === 0 ? x : y;
					const t = (limit - previousValue) / (value - previousValue);
					run.push(previousX + (x - previousX) * t, previousY + (y - previousY) * t);
					if (!inside) {
						if (run.length >= 4) next.push(run);
						run = [];
					}
				}
				if (inside) run.push(x, y);
				previousX = x;
				previousY = y;
				previousInside = inside;
			}
			if (run.length >= 4) next.push(run);
		}
		pieces = next;
		if (pieces.length === 0) return pieces;
	}
	return pieces;
}

function polygonPath(polygon: readonly number[]): string {
	let out = '';
	let lastX = NaN;
	let lastY = NaN;
	for (let i = 0; i < polygon.length; i += 2) {
		const x = Math.round(polygon[i] * 100) / 100;
		const y = Math.round(polygon[i + 1] * 100) / 100;
		// Clipping a coastline that leaves and re-enters the box lands two vertices on the
		// same spot on the border, and a continent can do that a dozen times in one
		// preview. Same picture either way; this is only DOM the card does not have to
		// carry.
		if (x === lastX && y === lastY) continue;
		out += `${out === '' ? 'M' : 'L'}${x} ${y}`;
		lastX = x;
		lastY = y;
	}
	return out.includes('L') ? `${out}Z` : '';
}

function groupPath(group: LandGroup): string {
	return group.polygons.map(polygonPath).join('');
}

function linePath(line: readonly number[]): string {
	let out = '';
	let lastX = NaN;
	let lastY = NaN;
	for (let i = 0; i < line.length; i += 2) {
		const x = Math.round(line[i] * 100) / 100;
		const y = Math.round(line[i + 1] * 100) / 100;
		if (x === lastX && y === lastY) continue;
		out += `${out === '' ? 'M' : 'L'}${x} ${y}`;
		lastX = x;
		lastY = y;
	}
	return out.includes('L') ? out : '';
}

/**
 * Whether a dot would read as standing on the land these groups draw: inside one of them,
 * or near enough to its shore to overlap it.
 *
 * Crossings are counted per group and by the even-odd rule the group is painted with, so a
 * dot in a lake counts as being in the lake and a dot on an island in that lake counts as
 * being on the island. Across groups it is "inside any", because two overlapping tiles
 * paint a union and reading them as one even-odd figure would call their overlap sea.
 */
function readsAsAshore(groups: readonly LandGroup[], point: ProjectedPoint): boolean {
	let nearest = Infinity;
	for (const group of groups) {
		let inside = false;
		for (const polygon of group.polygons) {
			const count = polygon.length / 2;
			for (let i = 0, j = count - 1; i < count; j = i++) {
				const xi = polygon[i * 2];
				const yi = polygon[i * 2 + 1];
				const xj = polygon[j * 2];
				const yj = polygon[j * 2 + 1];
				if (yi > point.y !== yj > point.y) {
					if (point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside;
				}
				if (!group.shore) continue;
				const dx = xj - xi;
				const dy = yj - yi;
				const length = dx * dx + dy * dy;
				const t =
					length === 0
						? 0
						: Math.max(0, Math.min(1, ((point.x - xi) * dx + (point.y - yi) * dy) / length));
				const distance = Math.hypot(xi + t * dx - point.x, yi + t * dy - point.y);
				if (distance < nearest) nearest = distance;
			}
		}
		if (inside) return true;
	}
	return nearest <= ASHORE_TOLERANCE;
}

/** How wide the frame is on the ground, at the latitude it is centred on. */
function frameWidthKm(frame: PreviewFrame): number {
	const latitude = inverseMercatorY((frame.north + frame.south) / 2);
	return (frame.east - frame.west) * Math.cos((latitude * Math.PI) / 180) * KM_PER_DEGREE_LONGITUDE;
}

/**
 * Which 360° copies of the world to try.
 *
 * The lines a preview draws live in one continuous longitude frame that can run past ±180
 * (`segments.ts`, `singleFrame`), so a Pacific route's window may sit at 170..200, or at
 * 530..560 after an arc has been unwrapped more than once, while every ring is written in
 * -180..180. Which copies to try is therefore a question about the frame, not a fixed
 * [-360, 0, 360]: `longitudeNear` shifts an arc as many times as it takes, and the land
 * under it has to follow.
 */
function worldOffsets(frame: PreviewFrame): number[] {
	const world = Math.round((frame.west + frame.east) / 720);
	return [(world - 1) * 360, world * 360, (world + 1) * 360];
}

/** Land from the bundled outline: every ring that reaches this window, projected and
 *  clipped, as one even-odd group so its lakes stay lakes. Synchronous, and the only
 *  source a flight preview ever uses. */
function outlineGroup(frame: PreviewFrame, width: number, height: number): LandGroup[] {
	const spanX = frame.east - frame.west;
	const spanY = frame.north - frame.south;
	const polygons: number[][] = [];
	const projected: number[] = [];

	// Below this many box units a ring is smaller than the display can show, and its whole
	// contribution is a few hundred characters of path data for a mark nobody sees. A
	// transatlantic preview reaches a thousand islands and this is most of them: 18.3 kB of
	// path becomes 3.0 kB, with no visible difference at 104 px.
	const invisible = 0.75;

	for (const ring of landRings()) {
		for (const offset of worldOffsets(frame)) {
			if (ring.east + offset < frame.west || ring.west + offset > frame.east) continue;
			if (ring.north < frame.south || ring.south > frame.north) continue;
			if (
				((ring.east - ring.west) / spanX) * width < invisible &&
				((ring.north - ring.south) / spanY) * height < invisible
			) {
				continue;
			}
			projected.length = 0;
			for (let i = 0; i < ring.points.length; i += 2) {
				projected.push(
					((ring.points[i] + offset - frame.west) / spanX) * width,
					((frame.north - ring.points[i + 1]) / spanY) * height
				);
			}
			const clipped = clipToBox(projected, width, height);
			if (clipped.length >= 6) polygons.push(clipped);
		}
	}
	return polygons.length === 0 ? [] : [{ polygons, shore: true }];
}

/** Every whole-degree cell the window covers, with the longitude offset that puts each one
 *  back in the frame's own continuous coordinates. */
function cellsCovering(frame: PreviewFrame): { x: number; y: number; offset: number }[] {
	const south = Math.floor(inverseMercatorY(frame.south));
	const north = Math.floor(inverseMercatorY(frame.north));
	const cells: { x: number; y: number; offset: number }[] = [];
	for (const offset of worldOffsets(frame)) {
		const west = frame.west - offset;
		const east = frame.east - offset;
		if (east < -180 || west > 180) continue;
		for (let x = Math.floor(Math.max(west, -180)); x <= Math.floor(Math.min(east, 179.999)); x++) {
			for (let y = south; y <= north; y++) cells.push({ x, y, offset });
		}
	}
	return cells;
}

/**
 * Land from the fetched tiles, or `undefined` when this window is not fully covered.
 *
 * Not fully covered means one of two things and they are treated alike: a block still on
 * the way, or a cell no tile covers. Drawing the cells that did answer would end the land
 * at a straight line on a whole degree of longitude, which is a coast that does not exist.
 */
function tileGroups(
	frame: PreviewFrame,
	width: number,
	height: number
): { land: LandGroup[]; borders: number[][] } | undefined {
	const spanX = frame.east - frame.west;
	const spanY = frame.north - frame.south;
	const projectX = (longitude: number, offset: number) => ((longitude + offset - frame.west) / spanX) * width;
	const projectY = (y: number) => ((frame.north - y) / spanY) * height;

	const land: LandGroup[] = [];
	const borders: number[][] = [];
	for (const { x, y, offset } of cellsCovering(frame)) {
		const cell = landCell(x, y);
		if (!cell) return undefined;

		if (cell.coast === 'land') {
			// A cell no coastline crosses, on the land side. Its own square is the land,
			// and its four edges are where the cell ends rather than where the water
			// starts, which is what `shore: false` says to the offshore-dot guard.
			const square = clipToBox(
				[
					projectX(x, offset),
					projectY(mercatorY(y)),
					projectX(x + 1, offset),
					projectY(mercatorY(y)),
					projectX(x + 1, offset),
					projectY(mercatorY(y + 1)),
					projectX(x, offset),
					projectY(mercatorY(y + 1))
				],
				width,
				height
			);
			if (square.length >= 6) land.push({ polygons: [square], shore: false });
		} else if (cell.coast !== 'sea') {
			const polygons: number[][] = [];
			for (const ring of cell.coast) {
				const projected: number[] = [];
				for (let i = 0; i < ring.length; i += 2) {
					projected.push(projectX(ring[i], offset), projectY(ring[i + 1]));
				}
				const clipped = clipToBox(projected, width, height);
				if (clipped.length >= 6) polygons.push(clipped);
			}
			// One group per cell: even-odd inside it so a lagoon stays water, and a path of
			// its own so the overlap with the next cell unions instead of cancelling.
			if (polygons.length > 0) land.push({ polygons, shore: true });
		}

		for (const line of cell.borders) {
			const projected: number[] = [];
			for (let i = 0; i < line.length; i += 2) {
				projected.push(projectX(line[i], offset), projectY(line[i + 1]));
			}
			borders.push(...clipLineToBox(projected, width, height));
		}
	}
	return { land, borders };
}

/**
 * Boundaries from the bundled layer, for a window wide enough to place one.
 *
 * That check does not fire today and is not dead: the boundary layer is 5.8 km out and the
 * outline is 6.8 km, so anything wide enough for the outline is already wide enough for
 * the borders. Both numbers are measured by their own generator against the geometry it
 * wrote, though, and the next rerun can move either. The relationship is a coincidence of
 * the current data, not an invariant, and the day the coastline gets finer is the day a
 * border would otherwise be drawn a seventh of the picture out of place.
 */
function outlineBorders(frame: PreviewFrame, width: number, height: number): number[][] {
	if (frameWidthKm(frame) < MIN_BOUNDARY_WINDOW_KM) return [];
	const spanX = frame.east - frame.west;
	const spanY = frame.north - frame.south;
	const offsets = worldOffsets(frame);
	const pieces: number[][] = [];
	for (const line of boundaryLines()) {
		for (const offset of offsets) {
			// Culled on bounds first, exactly as the rings are. Without this every preview
			// projects all 242 of the world's boundaries three times over, which measured as
			// half the render cost this issue added at five cards.
			if (line.east + offset < frame.west || line.west + offset > frame.east) continue;
			if (line.north < frame.south || line.south > frame.north) continue;
			const projected: number[] = [];
			for (let i = 0; i < line.points.length; i += 2) {
				projected.push(
					((line.points[i] + offset - frame.west) / spanX) * width,
					((frame.north - line.points[i + 1]) / spanY) * height
				);
			}
			pieces.push(...clipLineToBox(projected, width, height));
		}
	}
	return pieces;
}

/**
 * The map inside a preview's box, in the box's own units.
 *
 * Every land path is meant for `evenodd`: the vendored rings include the holes Natural
 * Earth marks in its land polygons, and a hole drawn into the same path as the land around
 * it cuts itself out with no winding rule to get right.
 *
 * An empty `land` means open sea, which happens and should look like it.
 */
export function previewMap(
	frame: PreviewFrame,
	width: number,
	height: number,
	points: readonly ProjectedPoint[]
): PreviewMap {
	const solid: PreviewMap = {
		land: [`M0 0L${width} 0L${width} ${height}L0 ${height}Z`],
		borders: '',
		source: 'solid'
	};
	if (frame.east <= frame.west || frame.north <= frame.south) return solid;

	const windowKm = frameWidthKm(frame);
	let land: LandGroup[];
	let borders: number[][];
	let source: PreviewMap['source'];
	if (windowKm >= MIN_OUTLINE_WINDOW_KM) {
		land = outlineGroup(frame, width, height);
		borders = outlineBorders(frame, width, height);
		source = 'outline';
	} else if (windowKm >= MIN_TILE_WINDOW_KM) {
		const tiles = tileGroups(frame, width, height);
		if (!tiles) return solid;
		land = tiles.land;
		borders = tiles.borders;
		source = 'tiles';
	} else {
		return solid;
	}

	// The check that stops a traveller's origin being drawn in the sea. Any dot the
	// geometry cannot account for means the land here is not to be trusted, whatever the
	// window spans, and a solid fill is the honest picture instead. The boundaries go with
	// it: a window whose coast is not trustworthy is not one to draw a border into either.
	for (const point of points) {
		if (!readsAsAshore(land, point)) return solid;
	}

	return {
		land: land.map(groupPath).filter((d) => d !== ''),
		borders: borders
			.map(linePath)
			.filter((d) => d !== '')
			.join(''),
		source
	};
}
