// Visvalingam-Whyatt line simplification with a per-vertex tolerance (issue #346).
//
// Split out from prepare-coastline.mjs so the rule that decides which vertex survives can
// be tested without downloading 10 MB of Natural Earth.
//
// The per-vertex part is the whole point. A single global tolerance cannot serve this app:
// the flight preview draws a continent across 104 px and wants nothing finer than about
// 20 km, while a ground preview draws a 20 km taxi ride across the same 104 px and needs
// every kilometre. Ranking vertices by `triangleArea / tolerance(vertex)` rather than by
// triangle area alone lets one pass produce both, and the bytes land only where this app
// can actually look: within a ground leg's reach of an airport it can route to.

const KM_PER_DEGREE = 111.32;
const rad = (degrees) => (degrees * Math.PI) / 180;

/**
 * Area of the triangle a-b-c in km², on an equirectangular plane tangent at `b`.
 *
 * Local rather than global: a degree of longitude is 111 km at the equator and 19 km at
 * Longyearbyen, and Visvalingam ranks vertices against each other, so measuring in raw
 * degrees would keep Arctic detail nobody asked for and strip the tropics bare.
 */
export function triangleAreaKm2(a, b, c) {
	const kx = Math.cos(rad(b[1])) * KM_PER_DEGREE;
	const ax = a[0] * kx;
	const ay = a[1] * KM_PER_DEGREE;
	const bx = b[0] * kx;
	const by = b[1] * KM_PER_DEGREE;
	const cx = c[0] * kx;
	const cy = c[1] * KM_PER_DEGREE;
	return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
}

/** Signed area of a closed ring in km², positive counter-clockwise. */
export function ringAreaKm2(ring) {
	let total = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const kx = Math.cos(rad((ring[i][1] + ring[j][1]) / 2)) * KM_PER_DEGREE;
		total +=
			ring[j][0] * kx * (ring[i][1] * KM_PER_DEGREE) - ring[i][0] * kx * (ring[j][1] * KM_PER_DEGREE);
	}
	return total / 2;
}

/** Binary min-heap over `[key, payload]`. */
class MinHeap {
	#items = [];

	push(key, payload) {
		const items = this.#items;
		items.push([key, payload]);
		let child = items.length - 1;
		while (child > 0) {
			const parent = (child - 1) >> 1;
			if (items[parent][0] <= items[child][0]) break;
			[items[parent], items[child]] = [items[child], items[parent]];
			child = parent;
		}
	}

	pop() {
		const items = this.#items;
		if (items.length === 0) return undefined;
		const top = items[0];
		const last = items.pop();
		if (items.length > 0) {
			items[0] = last;
			let parent = 0;
			for (;;) {
				const left = 2 * parent + 1;
				const right = left + 1;
				let smallest = parent;
				if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
				if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
				if (smallest === parent) break;
				[items[parent], items[smallest]] = [items[smallest], items[parent]];
				parent = smallest;
			}
		}
		return top;
	}
}

/**
 * Drops vertices from a closed ring cheapest-first until every survivor's triangle covers
 * at least the tolerance asked for at that vertex.
 *
 * `minPoints` is the floor that keeps this app's island destinations on the map. Natural
 * Earth's own 1:110m set answers "how far is Nuku Hiva from land" with 3,504 km, because
 * the Marquesas are not in it at all, and an itinerary drawn on that would put the
 * traveller's origin dot in open ocean. A ring is never simplified out of existence here:
 * below the floor it keeps its four corners and reads as a speck of land, which is what it
 * is.
 */
export function simplifyRing(ring, toleranceAt, minPoints = 4) {
	const isClosed =
		ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
	const points = isClosed ? ring.slice(0, -1) : ring.slice();
	const count = points.length;
	if (count <= minPoints) return ring;

	const alive = new Uint8Array(count).fill(1);
	const previous = new Int32Array(count);
	const next = new Int32Array(count);
	const tolerance = new Float64Array(count);
	// Bumped every time a vertex is re-scored, so a stale heap entry for it is recognised
	// and skipped rather than deleted — the standard lazy-deletion trick, and the reason
	// this runs in n log n instead of n² on a 100,000-point coastline.
	const version = new Int32Array(count);
	const heap = new MinHeap();
	for (let i = 0; i < count; i++) {
		previous[i] = (i - 1 + count) % count;
		next[i] = (i + 1) % count;
		tolerance[i] = toleranceAt(points[i]);
	}

	const score = (i) => {
		version[i]++;
		const ratio = triangleAreaKm2(points[previous[i]], points[i], points[next[i]]) / tolerance[i];
		heap.push(ratio, [i, version[i]]);
	};
	for (let i = 0; i < count; i++) score(i);

	let live = count;
	while (live > minPoints) {
		const top = heap.pop();
		if (!top) break;
		const [ratio, [index, stamp]] = top;
		if (!alive[index] || version[index] !== stamp) continue;
		if (ratio >= 1) break;
		alive[index] = 0;
		live--;
		const before = previous[index];
		const after = next[index];
		next[before] = after;
		previous[after] = before;
		score(before);
		score(after);
	}

	const kept = [];
	for (let i = 0; i < count; i++) if (alive[i]) kept.push(points[i]);
	return isClosed ? [...kept, kept[0]] : kept;
}
