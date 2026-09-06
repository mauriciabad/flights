#!/usr/bin/env node
// Rebuilds src/lib/data/boundaries.generated.ts from Natural Earth (issue #408).
//
// The owner, of the frozen previews: "I also expect the country boundaries to show". They
// were never in the vendored data at all — #346 shipped land polygons and nothing else.
//
// ## Source
//
// Natural Earth 1:10m admin-0 boundary lines, land only, public domain, the same licence
// and the same release as the coastline next door. Land only on purpose: a maritime
// boundary is an invisible line in open water, and drawing one on a picture whose sea is
// blank would be a line with nothing either side of it.
//
// ## Stitching, which is where the bytes went
//
// Natural Earth splits these into 7,980 fragments: a new one wherever the pair of
// countries changes, wherever a boundary meets a coast, and wherever its attributes do.
// The median fragment is 8.9 km long. That shape is expensive twice over. Every fragment
// restarts the delta encoding at an absolute coordinate, and Visvalingam cannot simplify
// what it cannot see past, so a border crossing a dozen fragment joins keeps a dozen
// vertices it would otherwise drop.
//
// Joining fragments that share an endpoint gives 252 continuous lines and throws nothing
// away. Measured: 32.7 kB gzipped before, 4.9 kB after, at the same tolerance and the same
// grid. Dropping short fragments would have been the obvious alternative and it is the
// wrong one — it buys the same bytes by leaving holes in real borders.
//
// ## Why this is bundled and the fine coast is not
//
// 4.9 kB is small enough to sit in the results chunk, and it has to: the flight preview is
// on every card, it is the picture a border is actually visible on, and a seam that
// appears 200 ms after the land redraws every card on the page. The fine detail a ground
// preview needs lives in `prepare-land-tiles.mjs`, fetched per region.
//
// Usage:
//   node scripts/prepare-boundaries.mjs [--input <ne_10m_admin_0_boundary_lines_land.geojson>] [--dry-run]

import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { simplifyRing } from './coastline-simplify.mjs';
import { encodeRing, RING_SEPARATOR } from '../src/lib/itinerary-map/coastline-codec.ts';

const SOURCE_URL =
	'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_boundary_lines_land.geojson';

const OUTPUT_PATH = fileURLToPath(new URL('../src/lib/data/boundaries.generated.ts', import.meta.url));

/**
 * The same 600 km² Visvalingam threshold the coastline's continents get, so a border
 * running down a river to the sea and the coast it meets there are simplified by the same
 * rule and stay in contact. About 35 km of shape, which is a few pixels of wobble on a
 * flight preview and invisible.
 */
const TOLERANCE_KM2 = 600;

/** The coastline's grid, for the same reason: a boundary that reaches a shore snaps to the
 *  same lattice the shore does rather than shimmering half a cell off it. */
const GRID_DEGREES = 0.05;

const KM_PER_DEGREE_LATITUDE = 110.57;
const KM_PER_DEGREE_LONGITUDE = 111.32;
const rad = (degrees) => (degrees * Math.PI) / 180;

function linesOf(geojson) {
	const lines = [];
	for (const feature of geojson.features) {
		if (!feature.geometry) continue;
		const parts =
			feature.geometry.type === 'LineString'
				? [feature.geometry.coordinates]
				: feature.geometry.coordinates;
		for (const part of parts) if (part.length >= 2) lines.push(part);
	}
	return lines;
}

/**
 * Joins polylines that share an endpoint into the longest chains they make.
 *
 * Greedy and order-dependent, which is fine: any chaining of the same fragments covers the
 * same ground, and this is a compression step rather than a topology one. A fragment whose
 * endpoint is shared by three others (a tripoint) joins one of them and leaves the rest to
 * start chains of their own, so nothing is dropped and nothing is drawn twice.
 */
export function stitchLines(parts) {
	const key = (point) => `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
	const byStart = new Map();
	const byEnd = new Map();
	parts.forEach((part, index) => {
		const start = key(part[0]);
		const end = key(part[part.length - 1]);
		if (!byStart.has(start)) byStart.set(start, []);
		byStart.get(start).push(index);
		if (!byEnd.has(end)) byEnd.set(end, []);
		byEnd.get(end).push(index);
	});

	const used = new Set();
	const chains = [];
	for (let i = 0; i < parts.length; i++) {
		if (used.has(i)) continue;
		used.add(i);
		let chain = [...parts[i]];
		for (;;) {
			const next = (byStart.get(key(chain[chain.length - 1])) ?? []).find((j) => !used.has(j));
			if (next === undefined) break;
			used.add(next);
			chain = chain.concat(parts[next].slice(1));
		}
		for (;;) {
			const previous = (byEnd.get(key(chain[0])) ?? []).find((j) => !used.has(j));
			if (previous === undefined) break;
			used.add(previous);
			chain = parts[previous].slice(0, -1).concat(chain);
		}
		chains.push(chain);
	}
	return chains;
}

/**
 * Visvalingam over an open polyline.
 *
 * `simplifyRing` is written for closed rings, where every vertex has two neighbours. An
 * open line's two ends have one each and must survive, so the line is closed by repeating
 * its first point, simplified, and reopened. `minPoints` of 2 lets a straight border
 * collapse to the two points that are all it ever was.
 */
function simplifyLine(line, toleranceKm2) {
	if (line.length <= 2) return line;
	const simplified = simplifyRing([...line, line[0]], () => toleranceKm2, 2);
	const reopened = simplified.slice(0, -1);
	return reopened.length >= 2 ? reopened : line;
}

function quantise(line, grid) {
	const out = [];
	for (const [longitude, latitude] of line) {
		const step = [Math.round(longitude / grid), Math.round(latitude / grid)];
		const last = out[out.length - 1];
		if (last && last[0] === step[0] && last[1] === step[1]) continue;
		out.push(step);
	}
	return out;
}

function distanceToLineKm(line, longitude, latitude) {
	const kx = Math.cos(rad(latitude)) * KM_PER_DEGREE_LONGITUDE;
	let best = Infinity;
	for (let i = 1; i < line.length; i++) {
		const ax = (line[i - 1][0] - longitude) * kx;
		const ay = (line[i - 1][1] - latitude) * KM_PER_DEGREE_LATITUDE;
		const bx = (line[i][0] - longitude) * kx;
		const by = (line[i][1] - latitude) * KM_PER_DEGREE_LATITUDE;
		const dx = bx - ax;
		const dy = by - ay;
		const length = dx * dx + dy * dy;
		const t = length === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / length));
		const distance = Math.hypot(ax + t * dx, ay + t * dy);
		if (distance < best) best = distance;
	}
	return best;
}

async function loadSource(inputPath) {
	if (inputPath) return JSON.parse(await readFile(inputPath, 'utf-8'));
	console.log(`fetching ${SOURCE_URL}`);
	const response = await fetch(SOURCE_URL);
	if (!response.ok) throw new Error(`${SOURCE_URL} answered ${response.status}`);
	return response.json();
}

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
	const source = await loadSource(argValue('--input'));
	const fragments = linesOf(source);
	const sourceVertices = fragments.reduce((total, line) => total + line.length, 0);
	console.log(`${fragments.length} fragments, ${sourceVertices} vertices in the source`);

	const stitched = stitchLines(fragments);
	console.log(`${stitched.length} continuous boundaries after stitching shared endpoints`);

	const simplified = stitched.map((line) => simplifyLine(line, TOLERANCE_KM2));
	const quantised = simplified.map((line) => quantise(line, GRID_DEGREES)).filter((line) => line.length >= 2);
	const outputVertices = quantised.reduce((total, line) => total + line.length, 0);
	console.log(
		`${quantised.length} lines kept, ${outputVertices} vertices (${((outputVertices / sourceVertices) * 100).toFixed(1)}% of the source)`
	);

	const encoded = quantised.map((line) => encodeRing(line)).join(RING_SEPARATOR);
	const gzipped = gzipSync(Buffer.from(encoded), { level: 9 }).length;
	console.log(`encoded ${encoded.length} bytes, ${gzipped} gzipped`);

	// How far this layer moves a border from where its source puts it, measured the way
	// the coastline's own displacement is: against the output that actually ships, at every
	// vertex of the source, so simplification and the grid snap are both in the number.
	// `land.ts` sizes the window a border is worth drawing into on this.
	const snapped = quantised.map((line) =>
		line.map(([x, y]) => [x * GRID_DEGREES, y * GRID_DEGREES])
	);
	// Output lines bucketed by one-degree cell, so measuring 77,000 source vertices is a
	// look at nine cells each rather than a scan of every line in the world.
	const cells = new Map();
	snapped.forEach((line, index) => {
		for (let i = 1; i < line.length; i++) {
			const [ax, ay] = line[i - 1];
			const [bx, by] = line[i];
			for (let x = Math.floor(Math.min(ax, bx)); x <= Math.floor(Math.max(ax, bx)); x++) {
				for (let y = Math.floor(Math.min(ay, by)); y <= Math.floor(Math.max(ay, by)); y++) {
					const key = `${x},${y}`;
					if (!cells.has(key)) cells.set(key, new Set());
					cells.get(key).add(index);
				}
			}
		}
	});
	const displacements = [];
	for (const fragment of fragments) {
		for (const [longitude, latitude] of fragment) {
			const nearby = new Set();
			for (let x = Math.floor(longitude) - 1; x <= Math.floor(longitude) + 1; x++) {
				for (let y = Math.floor(latitude) - 1; y <= Math.floor(latitude) + 1; y++) {
					for (const index of cells.get(`${x},${y}`) ?? []) nearby.add(index);
				}
			}
			if (nearby.size === 0) continue;
			displacements.push(
				Math.min(...[...nearby].map((index) => distanceToLineKm(snapped[index], longitude, latitude)))
			);
		}
	}
	if (displacements.length === 0) {
		throw new Error('no boundary vertex to measure displacement against; the source is wrong');
	}
	displacements.sort((a, b) => a - b);
	const percentile = (fraction) => displacements[Math.floor(displacements.length * fraction)];
	const displacementP75 = Math.round(percentile(0.75) * 10) / 10;
	console.log(
		`boundary displacement over ${displacements.length} source vertices: median ${percentile(0.5).toFixed(2)} km, p75 ${displacementP75} km`
	);

	if (process.argv.includes('--dry-run')) return;

	const module = `// Generated by scripts/prepare-boundaries.mjs. Do not edit.
//
// Natural Earth 1:10m admin-0 boundary lines (land), public domain, ${fragments.length} fragments joined
// end to end into ${stitched.length} continuous boundaries and simplified to about ${Math.round(Math.sqrt(2 * TOLERANCE_KM2))} km of shape.
//
// ${quantised.length} lines and ${outputVertices} vertices, from ${fragments.length} and ${sourceVertices}.

/** Degrees per step of the integer grid the lines are quantised to. The coastline's, so a
 *  border reaching a shore snaps to the same lattice the shore does. */
export const BOUNDARY_GRID_DEGREES = ${GRID_DEGREES};

/**
 * How far this layer moves a border from where its source puts it, in kilometres, at the
 * 75th percentile over every vertex of the source.
 *
 * \`land.ts\` sizes the window a border is worth drawing into on this, by the same rule and
 * the same multiple it uses for the coastline. Measured against the lines below rather
 * than inferred from the tolerance they were simplified with.
 */
export const BOUNDARY_DISPLACEMENT_KM = ${displacementP75};

/** Lines separated by a space, each one polyline-encoded grid steps. Open, not closed:
 *  these are strokes, never fills. */
export const BOUNDARY_LINES =
\t'${encoded}';
`;

	await writeFile(OUTPUT_PATH, module);
	console.log(`wrote ${OUTPUT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
