#!/usr/bin/env node
// Writes static/land/<version>/<block>.txt and src/lib/data/land-tiles.generated.ts from
// Natural Earth (issue #408).
//
// The owner: "the inerte Maps don't show the water and land in different colors, they are
// a solid gray always (in some searches they work)". Every ground-leg preview is a solid
// grey box, because `land.ts` will not draw a coast into a window narrower than twelve
// times its own placement error, and the vendored outline's error is 6.8 km. A 20 km taxi
// ride never clears 81.6 km.
//
// ## What #346 measured, and what it did not
//
// `prepare-coastline.mjs` says a coast fine enough for a 20 km window is "the whole
// world's inhabited shore at 1 km: measured, 218 kB gzipped, which an app with no backend
// does not spend". That number is right and it is still right: rebuilt here it is 231 kB.
//
// What it assumed is that the choice was between shipping all of it and shipping none of
// it. A ground leg frames one 20 km window somewhere a traveller stands, and there are
// only so many of those. Cut to 1° cells that hold or neighbour an airport, grouped into
// 5° blocks and fetched when a preview needs one, the median block is a few hundred bytes.
// A static file is not a backend.
//
// ## The shape of it
//
//   - A cell is one degree square. Every cell holding an airport, plus its eight
//     neighbours, because a leg can run out of town and a frame straddles cell lines.
//   - A cell's record is its coast, its borders, or the fact that it is all land or all
//     sea. That last part is what lets an inland preview fill solid and *know* it is
//     right, rather than filling solid because it has nothing.
//   - Rings are clipped to the cell plus a small margin, so neighbouring tiles overlap.
//     Overlap on purpose: two tiles abutting exactly would antialias into a hairline
//     across the picture, and a hairline is a line, which is the one thing these drawings
//     may not invent. `land.ts` draws one <path> per tile so the overlap unions instead of
//     cancelling under `evenodd`.
//   - 0.002° of grid, 222 m. Measured displacement p75 is 68 m, so twelve times that is a
//     820 m window: every ground leg this app can build resolves.
//
// ## Why the ring-keep rule is looser here than in the coastline
//
// `prepare-coastline.mjs` drops a ring under 3,000 km² unless a traveller stands on it,
// because at flight scale a rock is a smudge and there are 6,838 of them. At 20 km across
// a thumbnail the rocks in a harbour are the picture. Every ring intersecting a candidate
// cell is kept here, and the cost is small because a rock has few vertices.
//
// The output is committed, so `pnpm build` never downloads anything.
//
// Usage:
//   node scripts/prepare-land-tiles.mjs [--land <ne_10m_land.geojson>] \
//        [--boundaries <ne_10m_admin_0_boundary_lines_land.geojson>] [--dry-run]

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { simplifyRing } from './coastline-simplify.mjs';
import { stitchLines } from './prepare-boundaries.mjs';
import { encodeRing, RING_SEPARATOR } from '../src/lib/itinerary-map/coastline-codec.ts';

const LAND_URL =
	'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson';
const BOUNDARIES_URL =
	'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_boundary_lines_land.geojson';

const AIRPORTS_PATH = fileURLToPath(new URL('../src/lib/data/airports.generated.json', import.meta.url));
const STATIC_ROOT = fileURLToPath(new URL('../static/land', import.meta.url));
const OUTPUT_PATH = fileURLToPath(new URL('../src/lib/data/land-tiles.generated.ts', import.meta.url));

/**
 * Visvalingam threshold for a tile, in km². `sqrt(2 x tolerance)` is the feature length it
 * erases: 316 m, which is under two pixels at the tightest window a ground leg produces.
 */
const TOLERANCE_KM2 = 0.05;

/** Degrees per grid step. 222 m, a fifth of what the tolerance keeps, so quantisation is
 *  never what loses a shape the simplifier decided was worth keeping. */
const GRID_DEGREES = 0.002;

/** How far past its own cell a tile carries geometry. 5.5 km, enough that two neighbouring
 *  tiles overlap rather than abut. See the header on why abutting is the bad one. */
const MARGIN_DEGREES = 0.05;

/**
 * Cells per block, per side. Measured over the whole set, gzipped:
 *
 *   1°   3,686 files, median   173 B, p90   374 B
 *   5°   1,001 files, median   389 B, p90 1,987 B
 *   10°    326 files, median 1,238 B, p90 5,980 B
 *
 * Five, because a ground preview fetches one block and the traveller's bytes are the ones
 * worth minimising; 10° triples them to save 675 generated files nobody reads. 1° would
 * halve them again and cost 3,686 files, which is a directory rather than an asset.
 */
const BLOCK_DEGREES = 5;

const KM_PER_DEGREE_LATITUDE = 110.57;
const KM_PER_DEGREE_LONGITUDE = 111.32;
const rad = (degrees) => (degrees * Math.PI) / 180;

/** A cell with no coast in it is one of these two, and saying which is the difference
 *  between an honest solid fill and a solid fill that is only a shrug. */
const ALL_LAND = 'L';
const ALL_SEA = 'S';

function ringsOf(geojson) {
	const rings = [];
	for (const feature of geojson.features) {
		const polygons =
			feature.geometry.type === 'Polygon'
				? [feature.geometry.coordinates]
				: feature.geometry.coordinates;
		for (const polygon of polygons) for (const ring of polygon) rings.push(ring);
	}
	return rings;
}

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

/** Every one-degree cell a polyline's segments pass through, as a `Map<cell, Set<index>>`. */
function indexByCell(parts) {
	const index = new Map();
	parts.forEach((part, id) => {
		for (let i = 1; i < part.length; i++) {
			const [ax, ay] = part[i - 1];
			const [bx, by] = part[i];
			for (let x = Math.floor(Math.min(ax, bx)); x <= Math.floor(Math.max(ax, bx)); x++) {
				for (let y = Math.floor(Math.min(ay, by)); y <= Math.floor(Math.max(ay, by)); y++) {
					const key = `${x},${y}`;
					let bucket = index.get(key);
					if (!bucket) index.set(key, (bucket = new Set()));
					bucket.add(id);
				}
			}
		}
	});
	return index;
}

const insideOf = (point, axis, limit, keepBelow) =>
	keepBelow ? point[axis] <= limit : point[axis] >= limit;

function crossingAt(from, to, axis, limit) {
	const t = (limit - from[axis]) / (to[axis] - from[axis]);
	return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/** Sutherland-Hodgman against one edge of the box, for a closed ring. The classic caveat
 *  applies and does not matter: a concave shape can come back as pieces joined by an edge
 *  running along the border, which is invisible in a fill. */
function clipRingEdge(points, axis, limit, keepBelow) {
	const kept = [];
	if (points.length === 0) return kept;
	let previous = points[points.length - 1];
	let previousInside = insideOf(previous, axis, limit, keepBelow);
	for (const point of points) {
		const nowInside = insideOf(point, axis, limit, keepBelow);
		if (nowInside !== previousInside) kept.push(crossingAt(previous, point, axis, limit));
		if (nowInside) kept.push(point);
		previous = point;
		previousInside = nowInside;
	}
	return kept;
}

function clipRingToBox(points, west, south, east, north) {
	let clipped = clipRingEdge(points, 0, west, false);
	if (clipped.length === 0) return clipped;
	clipped = clipRingEdge(clipped, 0, east, true);
	if (clipped.length === 0) return clipped;
	clipped = clipRingEdge(clipped, 1, south, false);
	if (clipped.length === 0) return clipped;
	return clipRingEdge(clipped, 1, north, true);
}

/**
 * Clips an open polyline to the box, returning the pieces that survive.
 *
 * Pieces rather than one array, and this is the whole difference from clipping a ring. A
 * border that leaves the box and comes back has two separate runs inside it, and
 * concatenating them draws a straight line across the gap between them — an invented
 * border, in the one place on this drawing where an invented line is unforgivable.
 */
function clipLineToBox(points, west, south, east, north) {
	let pieces = [points];
	for (const [axis, limit, keepBelow] of [
		[0, west, false],
		[0, east, true],
		[1, south, false],
		[1, north, true]
	]) {
		const next = [];
		for (const piece of pieces) {
			let run = [];
			let previous = piece[0];
			let previousInside = insideOf(previous, axis, limit, keepBelow);
			if (previousInside) run.push(previous);
			for (let i = 1; i < piece.length; i++) {
				const point = piece[i];
				const nowInside = insideOf(point, axis, limit, keepBelow);
				if (nowInside !== previousInside) {
					run.push(crossingAt(previous, point, axis, limit));
					if (!nowInside) {
						if (run.length >= 2) next.push(run);
						run = [];
					}
				}
				if (nowInside) run.push(point);
				previous = point;
				previousInside = nowInside;
			}
			if (run.length >= 2) next.push(run);
		}
		pieces = next;
		if (pieces.length === 0) return pieces;
	}
	return pieces;
}

function quantise(points) {
	const out = [];
	for (const [longitude, latitude] of points) {
		const step = [Math.round(longitude / GRID_DEGREES), Math.round(latitude / GRID_DEGREES)];
		const last = out[out.length - 1];
		if (last && last[0] === step[0] && last[1] === step[1]) continue;
		out.push(step);
	}
	return out;
}

function encodeParts(parts, minimum) {
	return parts
		.map(quantise)
		.filter((part) => part.length >= minimum)
		.map(encodeRing)
		.join(RING_SEPARATOR);
}

/**
 * Which cells of one row of the grid are land, by casting a single ray along that row.
 *
 * Point-in-polygon per cell would be 13,909 scans of 446,175 vertices. One scan per row of
 * latitude collects every crossing once, sorts them, and every cell in the row reads its
 * own parity off that list. Even-odd across every ring at once, which is how the fill is
 * painted, so a lake counts as water and an island in it as land.
 */
function landCellsInRow(rings, latitude) {
	const crossings = [];
	for (const ring of rings) {
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [xi, yi] = ring[i];
			const [xj, yj] = ring[j];
			if (yi > latitude !== yj > latitude) {
				crossings.push(((xj - xi) * (latitude - yi)) / (yj - yi) + xi);
			}
		}
	}
	crossings.sort((a, b) => a - b);
	return (longitude) => {
		// Parity of the crossings strictly east of the point, matching `isLand`'s ray.
		let low = 0;
		let high = crossings.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (crossings[mid] <= longitude) low = mid + 1;
			else high = mid;
		}
		return (crossings.length - low) % 2 === 1;
	};
}

function distanceToRingKm(ring, longitude, latitude) {
	const kx = Math.cos(rad(latitude)) * KM_PER_DEGREE_LONGITUDE;
	let best = Infinity;
	for (let i = 1; i < ring.length; i++) {
		const ax = (ring[i - 1][0] - longitude) * kx;
		const ay = (ring[i - 1][1] - latitude) * KM_PER_DEGREE_LATITUDE;
		const bx = (ring[i][0] - longitude) * kx;
		const by = (ring[i][1] - latitude) * KM_PER_DEGREE_LATITUDE;
		const dx = bx - ax;
		const dy = by - ay;
		const length = dx * dx + dy * dy;
		const t = length === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / length));
		const distance = Math.hypot(ax + t * dx, ay + t * dy);
		if (distance < best) best = distance;
	}
	return best;
}

async function load(inputPath, url) {
	if (inputPath) return JSON.parse(await readFile(inputPath, 'utf-8'));
	console.log(`fetching ${url}`);
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response.json();
}

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const blockOf = (x, y) => `${Math.floor(x / BLOCK_DEGREES)}_${Math.floor(y / BLOCK_DEGREES)}`;

async function main() {
	const airports = JSON.parse(await readFile(AIRPORTS_PATH, 'utf-8'));
	const land = await load(argValue('--land'), LAND_URL);
	const boundaries = await load(argValue('--boundaries'), BOUNDARIES_URL);

	const sourceRings = ringsOf(land);
	const borderLines = stitchLines(linesOf(boundaries));
	console.log(
		`${sourceRings.length} land rings, ${borderLines.length} stitched boundaries in the source`
	);

	// Every cell an airport stands in, plus its eight neighbours: a transfer can leave the
	// cell its airport sits in, and a frame straddles cell lines.
	const cells = new Set();
	for (const airport of airports) {
		const cx = Math.floor(airport.longitude);
		const cy = Math.floor(airport.latitude);
		for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) cells.add(`${x},${y}`);
	}
	console.log(`${cells.size} cells within reach of an airport`);

	const coastIndex = indexByCell(sourceRings);
	const borderIndex = indexByCell(borderLines);

	// Simplified once per ring and reused by every cell it touches, rather than once per
	// cell: the same continent is clipped into hundreds of tiles and re-simplifying it for
	// each is the whole runtime of this script.
	const fineRings = sourceRings.map((ring) => simplifyRing(ring, () => TOLERANCE_KM2));
	const fineBorders = borderLines.map((line) => {
		if (line.length <= 2) return line;
		const closed = simplifyRing([...line, line[0]], () => TOLERANCE_KM2, 2);
		const reopened = closed.slice(0, -1);
		return reopened.length >= 2 ? reopened : line;
	});

	// Cells grouped by the block they belong to, so a continent is clipped to a 5° block
	// once and the twenty-five cells inside then clip that instead of clipping the
	// continent again. Straight to cells is 13,909 passes over a ring with 150,000
	// vertices, which does not finish.
	const cellsByBlock = new Map();
	for (const key of cells) {
		const [x, y] = key.split(',').map(Number);
		const block = blockOf(x, y);
		if (!cellsByBlock.has(block)) cellsByBlock.set(block, []);
		cellsByBlock.get(block).push([x, y]);
	}

	// One ray per row of latitude, shared by every cell in it.
	const rowTests = new Map();
	const landAt = (x, y) => {
		let test = rowTests.get(y);
		if (!test) rowTests.set(y, (test = landCellsInRow(sourceRings, y + 0.5)));
		return test(x + 0.5);
	};

	const blocks = new Map();
	let coastCells = 0;
	let landCells = 0;
	let seaCells = 0;
	let borderCells = 0;
	for (const [block, blockCells] of cellsByBlock) {
		const [bx, by] = block.split('_').map(Number);
		const blockWest = bx * BLOCK_DEGREES - MARGIN_DEGREES;
		const blockSouth = by * BLOCK_DEGREES - MARGIN_DEGREES;
		const blockEast = (bx + 1) * BLOCK_DEGREES + MARGIN_DEGREES;
		const blockNorth = (by + 1) * BLOCK_DEGREES + MARGIN_DEGREES;

		const ringsHere = new Set();
		const bordersHere = new Set();
		for (const [x, y] of blockCells) {
			for (const id of coastIndex.get(`${x},${y}`) ?? []) ringsHere.add(id);
			for (const id of borderIndex.get(`${x},${y}`) ?? []) bordersHere.add(id);
		}
		const coastInBlock = [...ringsHere]
			.map((id) => clipRingToBox(fineRings[id], blockWest, blockSouth, blockEast, blockNorth))
			.filter((piece) => piece.length >= 4);
		const bordersInBlock = [...bordersHere].flatMap((id) =>
			clipLineToBox(fineBorders[id], blockWest, blockSouth, blockEast, blockNorth)
		);

		const records = [];
		for (const [x, y] of blockCells) {
			const west = x - MARGIN_DEGREES;
			const south = y - MARGIN_DEGREES;
			const east = x + 1 + MARGIN_DEGREES;
			const north = y + 1 + MARGIN_DEGREES;

			let coast = '';
			if (coastIndex.get(`${x},${y}`)?.size) {
				const pieces = coastInBlock
					.map((piece) => clipRingToBox(piece, west, south, east, north))
					.filter((piece) => piece.length >= 4);
				coast = encodeParts(pieces, 4);
				if (coast) coastCells += 1;
			}
			if (!coast) {
				// No coast crosses this cell, so it is entirely one thing. Which one is a
				// fact worth one byte: it turns a preview's solid fill from "nothing is
				// known here" into "this window is inland", which is the claim the owner is
				// actually being shown.
				const ashore = landAt(x, y);
				coast = ashore ? ALL_LAND : ALL_SEA;
				if (ashore) landCells += 1;
				else seaCells += 1;
			}

			let borders = '';
			if (borderIndex.get(`${x},${y}`)?.size) {
				const pieces = bordersInBlock.flatMap((piece) =>
					clipLineToBox(piece, west, south, east, north)
				);
				borders = encodeParts(pieces, 2);
				if (borders) borderCells += 1;
			}

			records.push(`${x},${y}|${coast}|${borders}`);
		}
		blocks.set(block, records);
	}
	console.log(
		`${coastCells} cells carry a coast, ${landCells} are all land, ${seaCells} all sea, ${borderCells} carry a border`
	);

	const files = new Map();
	for (const [block, lines] of blocks) {
		lines.sort();
		files.set(block, `${lines.join('\n')}\n`);
	}
	const sizes = [...files.values()]
		.map((body) => gzipSync(Buffer.from(body), { level: 9 }).length)
		.sort((a, b) => a - b);
	const raw = [...files.values()].reduce((total, body) => total + body.length, 0);
	console.log(
		`${files.size} blocks, ${(raw / 1024).toFixed(0)} kB on disk, ${(sizes.reduce((t, s) => t + s, 0) / 1024).toFixed(0)} kB gzipped total`
	);
	console.log(
		`  per block gzipped: median ${sizes[Math.floor(sizes.length / 2)]} B, p90 ${sizes[Math.floor(sizes.length * 0.9)]} B, max ${sizes[sizes.length - 1]} B`
	);

	// One hash over every byte that ships, carried in the query string every tile is
	// fetched with. A URL is then immutable in the browser's cache and a deploy that
	// changes the data cannot be served the old one, without a versioned directory whose
	// every regeneration would show up in git as a thousand deletions and a thousand
	// additions of the same files.
	const hash = createHash('sha256');
	for (const block of [...files.keys()].sort()) hash.update(block).update(files.get(block));
	const version = hash.digest('hex').slice(0, 8);

	// Which blocks exist, as one character per block of the whole grid. A preview that
	// wants a block not in here asks for nothing instead of asking for a 404.
	const columns = 360 / BLOCK_DEGREES;
	const rows = 180 / BLOCK_DEGREES;
	const manifest = Array.from({ length: columns * rows }, (_, index) => {
		const bx = (index % columns) - columns / 2;
		const by = Math.floor(index / columns) - rows / 2;
		return files.has(`${bx}_${by}`) ? '1' : '0';
	}).join('');

	// How far a tile moves a coast from where its source puts it, at the airports where it
	// matters — the same measurement `prepare-coastline.mjs` makes against the outline it
	// writes, and for the same reason: `land.ts` sizes its draw-or-fill threshold on this,
	// and a number copied by hand goes quietly wrong the next time this is rerun.
	const snapped = fineRings.map((ring) => quantise(ring).map(([x, y]) => [x * GRID_DEGREES, y * GRID_DEGREES]));
	const displacements = [];
	for (const airport of airports) {
		const near = (rings) =>
			rings.filter((ring) =>
				ring.some(
					([longitude, latitude]) =>
						Math.abs(latitude - airport.latitude) < 2 && Math.abs(longitude - airport.longitude) < 2
				)
			);
		const fromSource = near(sourceRings);
		if (fromSource.length === 0) continue;
		const sourceDistance = Math.min(
			...fromSource.map((ring) => distanceToRingKm(ring, airport.longitude, airport.latitude))
		);
		if (sourceDistance > 50) continue;
		const fromOutput = near(snapped);
		const outputDistance = fromOutput.length
			? Math.min(...fromOutput.map((ring) => distanceToRingKm(ring, airport.longitude, airport.latitude)))
			: Infinity;
		displacements.push(Math.abs(outputDistance - sourceDistance));
	}
	displacements.sort((a, b) => a - b);
	const percentile = (fraction) => displacements[Math.floor(displacements.length * fraction)];
	const displacementP75 = Math.round(percentile(0.75) * 1000) / 1000;
	console.log(
		`tile displacement at ${displacements.length} coastal airports: median ${percentile(0.5).toFixed(3)} km, p75 ${displacementP75} km`
	);

	if (process.argv.includes('--dry-run')) return;

	await rm(STATIC_ROOT, { recursive: true, force: true });
	await mkdir(STATIC_ROOT, { recursive: true });
	for (const [block, body] of files) {
		await writeFile(path.join(STATIC_ROOT, `${block}.txt`), body);
	}
	console.log(`wrote ${files.size} files to ${STATIC_ROOT}`);

	const module = `// Generated by scripts/prepare-land-tiles.mjs. Do not edit.
//
// Natural Earth 1:10m land and admin-0 land boundaries, public domain, clipped to the
// ${cells.size} one-degree cells within reach of an airport and grouped into ${files.size} blocks of
// ${BLOCK_DEGREES}°. The tiles themselves are in static/land/, ${(raw / 1024).toFixed(0)} kB on disk and a median of
// ${sizes[Math.floor(sizes.length / 2)]} B gzipped over the wire; nothing here is bundled but the numbers.

/** Content hash of every tile, carried as \`?v=\` on each fetch. A URL is then immutable in
 *  the browser's cache, and a deploy that changes the data cannot be served the old one. */
export const LAND_TILE_VERSION = '${version}';

/** Degrees per side of one block file, and of one cell record inside it. */
export const LAND_TILE_BLOCK_DEGREES = ${BLOCK_DEGREES};
export const LAND_TILE_CELL_DEGREES = 1;

/** Degrees per step of the integer grid the tiles are quantised to. */
export const LAND_TILE_GRID_DEGREES = ${GRID_DEGREES};

/**
 * How far a tile moves a coast from where its source puts it, in kilometres, at the 75th
 * percentile over the ${displacements.length} airports within 50 km of a shore.
 *
 * \`land.ts\` sizes its draw-or-fill threshold on this, by the same rule and the same
 * multiple it applies to the vendored outline. Twelve times ${displacementP75} km is a ${(displacementP75 * 12).toFixed(2)} km window,
 * which every ground leg this app can build clears.
 */
export const LAND_TILE_DISPLACEMENT_KM = ${displacementP75};

/** How far past its own cell a tile carries geometry, so neighbouring tiles overlap
 *  rather than abut. \`land.ts\` draws one path per tile for the same reason. */
export const LAND_TILE_MARGIN_DEGREES = ${MARGIN_DEGREES};

/** A cell with no coast in it, in the tile format: entirely land, or entirely sea. */
export const LAND_TILE_ALL_LAND = '${ALL_LAND}';
export const LAND_TILE_ALL_SEA = '${ALL_SEA}';

/**
 * Which blocks exist, one character per block over the whole grid, row-major from
 * (-180, -90). A preview whose window falls outside every airport's reach asks for nothing
 * rather than asking for a 404.
 */
export const LAND_TILE_BLOCKS =
\t'${manifest}';
`;

	await writeFile(OUTPUT_PATH, module);
	console.log(`wrote ${OUTPUT_PATH}`);
}

await main();
