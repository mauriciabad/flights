/**
 * The land under a frozen preview (issue #346).
 *
 * The owner asked for this twice. In #305, of the flight ornament: "i expect tat it shows
 * the sea white (same as bg in parent element) and land a but gray (current gray is
 * fine)". Then again in #346, of everything: "in the flight map, the re's no map, it just
 * shwos the lines, same fot he other ground travels".
 *
 * So: one filled `<path>` under the arcs, in the grey the previews already used, on a
 * background that is whatever the parent element's is. No tiles, no labels, no second
 * colour, and above all no WebGL — #280 measured four MapLibre instances per card settling
 * in 4.5 s and twenty never settling at all, and that has to stay true.
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
 * **The coast is in roughly the wrong place.** Simplification moves it. Measured against
 * its own source at the 2,097 coastal airports in this app's dataset, the vendored outline
 * sits a median 2.1 km and a 75th-percentile 6.8 km from where 1:10m puts it. That is
 * nothing on a flight preview and everything on a ground one, because `projectToBox` fits
 * each preview to its own leg: a 20 km taxi ride gets a 20 km window, where 6.8 km is a
 * third of the picture. So a window has to be `DISPLACEMENT_MULTIPLE` times that error
 * before a coast is worth drawing into it.
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
 * None of this is a difference between the flight ornament and the three ground
 * thumbnails, and neither component knows about it. The picture decides for itself.
 *
 * Buying the accuracy instead was measured: coastline fine enough for a 20 km window is
 * the whole world's inhabited shore at 1 km, 218 kB gzipped, on an app with no backend.
 */

import {
	COASTLINE_DISPLACEMENT_KM,
	COASTLINE_GRID_DEGREES,
	COASTLINE_RINGS
} from '$lib/data/coastline.generated';
import { decodeRing, RING_SEPARATOR } from './coastline-codec';
import { mercatorY, type PreviewFrame, type ProjectedPoint } from './geo';

/**
 * How many times the outline's own placement error a window must span before a coast is
 * worth drawing into it.
 *
 * Twelve, so a coast is at worst a twelfth of the picture out of place: 9 px on a 104 px
 * preview, which reads as a soft shore rather than a wrong one.
 *
 * `COASTLINE_DISPLACEMENT_KM` is measured by the script that writes the outline, against
 * the outline it actually wrote. It is not the simplifier's tolerance and the two differ
 * by a factor of four; reading this threshold off the tolerance made it that much more
 * timid than it needed to be, and hand-copying the measured figure into this file would
 * have gone quietly wrong the first time anyone reran the script.
 */
const DISPLACEMENT_MULTIPLE = 12;

const MIN_RESOLVED_WINDOW_KM = COASTLINE_DISPLACEMENT_KM * DISPLACEMENT_MULTIPLE;

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

let decoded: LandRing[] | undefined;

function landRings(): LandRing[] {
	if (decoded) return decoded;
	decoded = COASTLINE_RINGS.split(RING_SEPARATOR).map((encoded) => {
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
	return decoded;
}

/**
 * Sutherland-Hodgman against one axis-aligned edge of the box.
 *
 * The classic algorithm, and the classic caveat with it: clipping a concave shape against
 * a rectangle can leave two separate pieces joined by an edge that runs along the
 * rectangle's border. That is invisible in a fill, which is all this is ever used for.
 */
function clipEdge(
	polygon: readonly number[],
	axis: 0 | 1,
	limit: number,
	keepBelow: boolean
): number[] {
	const kept: number[] = [];
	const count = polygon.length / 2;
	if (count === 0) return kept;

	let previousX = polygon[(count - 1) * 2];
	let previousY = polygon[(count - 1) * 2 + 1];
	let previousValue = axis === 0 ? previousX : previousY;
	let previousInside = keepBelow ? previousValue <= limit : previousValue >= limit;

	for (let i = 0; i < count; i++) {
		const x = polygon[i * 2];
		const y = polygon[i * 2 + 1];
		const value = axis === 0 ? x : y;
		const inside = keepBelow ? value <= limit : value >= limit;
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

/**
 * Whether a dot would read as standing on the land these polygons draw: inside one of
 * them, or near enough to its shore to overlap it.
 *
 * Crossings are counted across every polygon at once rather than per polygon, which is the
 * same even-odd rule the fill is painted with, so a dot in a lake counts as being in the
 * lake and a dot on an island in that lake counts as being on the island.
 */
function readsAsAshore(polygons: readonly (readonly number[])[], point: ProjectedPoint): boolean {
	let inside = false;
	let nearest = Infinity;
	for (const polygon of polygons) {
		const count = polygon.length / 2;
		for (let i = 0, j = count - 1; i < count; j = i++) {
			const xi = polygon[i * 2];
			const yi = polygon[i * 2 + 1];
			const xj = polygon[j * 2];
			const yj = polygon[j * 2 + 1];
			if (yi > point.y !== yj > point.y) {
				if (point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside;
			}
			const dx = xj - xi;
			const dy = yj - yi;
			const length = dx * dx + dy * dy;
			const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - xi) * dx + (point.y - yi) * dy) / length));
			const distance = Math.hypot(xi + t * dx - point.x, yi + t * dy - point.y);
			if (distance < nearest) nearest = distance;
		}
	}
	return inside || nearest <= ASHORE_TOLERANCE;
}

/** How wide the frame is on the ground, at the latitude it is centred on. */
function frameWidthKm(frame: PreviewFrame): number {
	const midpoint = (frame.north + frame.south) / 2;
	// Inverse of `mercatorY`, needed only to turn a span in projected units into one in
	// kilometres. Nothing is drawn with it.
	const latitude = ((Math.atan(Math.exp((midpoint * Math.PI) / 180)) - Math.PI / 4) * 360) / Math.PI;
	return (frame.east - frame.west) * Math.cos((latitude * Math.PI) / 180) * KM_PER_DEGREE_LONGITUDE;
}

/**
 * The land inside a preview's box, as one SVG path in the box's own units.
 *
 * Returned as a single path with `evenodd` in mind: the vendored rings include the holes
 * Natural Earth marks in its land polygons, and a hole drawn into the same path as the
 * land around it cuts itself out with no winding rule to get right.
 *
 * An empty string means open sea, which happens and should look like it.
 */
export function landPath(
	frame: PreviewFrame,
	width: number,
	height: number,
	points: readonly ProjectedPoint[]
): string {
	const wholeBox = `M0 0L${width} 0L${width} ${height}L0 ${height}Z`;
	if (frame.east <= frame.west || frame.north <= frame.south) return wholeBox;
	if (frameWidthKm(frame) < MIN_RESOLVED_WINDOW_KM) return wholeBox;

	const spanX = frame.east - frame.west;
	const spanY = frame.north - frame.south;
	const polygons: number[][] = [];
	const projected: number[] = [];

	// The lines a preview draws live in one continuous longitude frame that can run past
	// ±180 (`segments.ts`, `singleFrame`), so a Pacific route's window may sit at 170..200,
	// or at 530..560 after an arc has been unwrapped more than once, while every ring is
	// written in -180..180. Which copies of the world to try is therefore a question about
	// the frame, not a fixed [-360, 0, 360]: `longitudeNear` shifts an arc as many times as
	// it takes, and the land under it has to follow.
	const world = Math.round((frame.west + frame.east) / 720);
	const offsets = [(world - 1) * 360, world * 360, (world + 1) * 360];

	// Below this many box units a ring is smaller than the display can show, and its whole
	// contribution is a few hundred characters of path data for a mark nobody sees. A
	// transatlantic preview reaches a thousand islands and this is most of them: 18.3 kB of
	// path becomes 3.0 kB, with no visible difference at 104 px.
	const invisible = 0.75;

	for (const ring of landRings()) {
		for (const offset of offsets) {
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

	// The check that stops a traveller's origin being drawn in the sea. Any dot the outline
	// cannot account for means the land here is not to be trusted, whatever the window
	// spans, and a solid fill is the honest picture instead.
	for (const point of points) {
		if (!readsAsAshore(polygons, point)) return wholeBox;
	}

	return polygons.map(polygonPath).join('');
}
