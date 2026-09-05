#!/usr/bin/env node
// Rebuilds src/lib/data/coastline.generated.ts and its audit file from Natural Earth
// (issue #346).
//
// Why this exists: the card's frozen previews drew arcs on nothing. The owner, twice:
// "in the flight map, the re's no map, it just shwos the lines, same fot he other ground
// travels", and before that, "i expect tat it shows the sea white (same as bg in parent
// element) and land a but gray (current gray is fine)". An arc between two dots cannot say
// whether a stopover is a detour north or a straight line down a coast.
//
// It is not a basemap and must never become one. #280 measured why: four MapLibre
// instances per card settle in 4.5 s, twenty never settle at all, because Chromium evicts
// WebGL contexts past sixteen. This ships land polygons and nothing else, drawn as one
// `<path>` under a frozen SVG.
//
// ## Source, and why not the obvious one
//
// Natural Earth 1:10m land, public domain, no attribution required.
//
// 1:110m is the usual choice for a picture this small, and it is unusable here, because
// this app sells island destinations. 110m has no Marquesas, no Cape Verde and no Bermuda,
// so it answers "how far is Nuku Hiva from land" with 3,504 km, and the traveller's origin
// dot would sit in open ocean. Measured over a 500-airport sample, 110m's coastline sits a
// median 8.1 km and a 75th-percentile 24.6 km from where 1:50m puts it.
//
// So the shape comes from 10m and the size comes from throwing almost all of it away.
//
// ## What is thrown away, and what is not
//
// Two rules, and between them they cut 446,175 vertices to 10,274, which is 2.3% of the
// source:
//
//   - A ring survives if it is big enough to read at flight scale, or if this app can put
//     a traveller on it. Everything else is a rock in an ocean, and this is where the
//     bytes were: 10m has 6,838 rings and most of them are uninhabited specks. Keeping
//     every ring within 80 km of an airport was measured at 48.7 kB gzipped; keeping the
//     ones a traveller actually stands on is 17.0 kB.
//   - A surviving ring is simplified to a vertex budget rather than to a fixed tolerance.
//     A continent gets COARSE_TOLERANCE_KM2. A small island gets whatever tolerance leaves
//     it about VERTEX_BUDGET vertices, so Boa Vista stays Boa Vista instead of collapsing
//     to the quadrilateral a fixed tolerance leaves of a 620 km² island.
//
// ## What this deliberately does not do
//
// It does not resolve a coastline at ground-leg scale. A ground preview frames a 20 km
// taxi ride across 104 px, and coastline fine enough for that is the whole world's
// inhabited shore at 1 km: measured, 218 kB gzipped, which an app with no backend does not
// spend. `land.ts` knows this and refuses to draw a coast it cannot stand behind.
//
// The output is committed, so `pnpm build` never downloads anything.
//
// Usage:
//   node scripts/prepare-coastline.mjs [--input <ne_10m_land.geojson>] [--dry-run]

import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ringAreaKm2, simplifyRing } from './coastline-simplify.mjs';
import { encodeRing, RING_SEPARATOR } from '../src/lib/itinerary-map/coastline-codec.ts';

const SOURCE_URL =
	'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson';

const AIRPORTS_PATH = fileURLToPath(
	new URL('../src/lib/data/airports.generated.json', import.meta.url)
);
const OUTPUT_PATH = fileURLToPath(new URL('../src/lib/data/coastline.generated.ts', import.meta.url));
const AUDIT_PATH = fileURLToPath(new URL('../src/lib/data/coastline.audit.tsv', import.meta.url));

/**
 * Coastline detail kept on a landmass big enough not to need a budget. Visvalingam's
 * threshold is an area, so the length it corresponds to is `sqrt(2 x tolerance)`: 35 km.
 *
 * The flight preview is 120 units wide and renders at 104 px, and the itineraries this app
 * builds span hundreds to thousands of kilometres, so a pixel is worth 5 km at the tight
 * end and 50 at the loose one. A 35 km feature is a few pixels of wobble on an outline
 * whose only job is to say which coast this is. Halving it to 300 km² cost 3 kB gzipped
 * and changed nothing visible at this size.
 */
const COARSE_TOLERANCE_KM2 = 600;

/**
 * Roughly how many vertices a small ring is allowed, by giving it `area / budget` as its
 * own tolerance instead of the coarse one.
 *
 * Visvalingam ranks a vertex by the area of the triangle it sits on, so a ring's own area
 * divided by a vertex count is the tolerance at which about that many vertices survive.
 * Twelve is where a Mediterranean island stops being a lozenge at preview size.
 */
const VERTEX_BUDGET = 12;

/**
 * How far off an island's shore an airport may sit and still keep it.
 *
 * Generous on purpose. Natural Earth draws an atoll as its outer reef, so Anaa's airstrip
 * measures 8 km from the nearest vertex of its own ring and Rangiroa's 15 km. A 5 km rule
 * dropped 101 airports into open water; this one leaves 92, and every one of those is a
 * Pacific island 1:10m does not carry at all.
 */
const AIRPORT_LAND_KM = 25;

/**
 * Below this, an island is kept only when an airport is *inside* it.
 *
 * The distance rule alone is what makes a coastal airport expensive: Athens has dozens of
 * rocks within 25 km and none of them is a place. 100 km² is about 10 km across, which is
 * the smallest thing worth a shape in a picture this size.
 */
const ISLAND_MIN_AREA_KM2 = 100;

/**
 * A ring this big is kept whether or not anyone flies there. 3,000 km² is about 55 km
 * across, which is a visible shape on a flight preview, and dropping unpopulated coastline
 * a long arc flies over would leave holes in the ocean.
 */
const ALWAYS_KEEP_AREA_KM2 = 3000;

/** Degrees per step of the integer grid coordinates are quantised to. 0.05° is 5.5 km, a
 *  sixth of the coarse tolerance, so quantisation is never what loses a shape the
 *  simplifier decided to keep, and most steps still encode in one character. */
const GRID_DEGREES = 0.05;

/** How close to the source coastline an airport has to be to count as coastal when the
 *  displacement below is measured. Wide enough to include an airport set back behind a
 *  city, narrow enough that an inland one never dilutes the figure. */
const COASTAL_AIRPORT_KM = 50;

const KM_PER_DEGREE_LATITUDE = 110.57;
const KM_PER_DEGREE_LONGITUDE = 111.32;
const rad = (degrees) => (degrees * Math.PI) / 180;

/** Airports in one-degree buckets, so "is one within 25 km of this vertex" is a look at
 *  nine cells rather than a scan of 4,133. */
function bucketAirports(airports) {
	const grid = new Map();
	for (const airport of airports) {
		const key = `${Math.floor(airport.longitude)},${Math.floor(airport.latitude)}`;
		const bucket = grid.get(key);
		if (bucket) bucket.push(airport);
		else grid.set(key, [airport]);
	}
	return grid;
}

function hasAirportWithin(grid, km, longitude, latitude) {
	const cx = Math.floor(longitude);
	const cy = Math.floor(latitude);
	for (let i = cx - 1; i <= cx + 1; i++) {
		for (let j = cy - 1; j <= cy + 1; j++) {
			const bucket = grid.get(`${i},${j}`);
			if (!bucket) continue;
			for (const airport of bucket) {
				const dy = (airport.latitude - latitude) * KM_PER_DEGREE_LATITUDE;
				const dx =
					(airport.longitude - longitude) * Math.cos(rad(latitude)) * KM_PER_DEGREE_LONGITUDE;
				if (Math.hypot(dx, dy) <= km) return true;
			}
		}
	}
	return false;
}

/**
 * Whether this app can put a traveller on this ring: an airport inside it, or one within
 * `AIRPORT_LAND_KM` of its shore.
 *
 * Containment first, and it is not the same question as distance: an airport on an island
 * big enough to have an inland runway is more than AIRPORT_LAND_KM from any vertex of it.
 * Testing only the shore dropped 213 airports into the sea before this was written the
 * right way round.
 */
function standsOnRing(grid, ring, area) {
	const b = boundsOf(ring);
	const cx = Math.floor(b.west);
	const cy = Math.floor(b.south);
	for (let i = cx; i <= Math.floor(b.east); i++) {
		for (let j = cy; j <= Math.floor(b.north); j++) {
			for (const airport of grid.get(`${i},${j}`) ?? []) {
				if (ringContains(ring, airport.longitude, airport.latitude)) return true;
			}
		}
	}
	return (
		area >= ISLAND_MIN_AREA_KM2 &&
		ring.some(([longitude, latitude]) => hasAirportWithin(grid, AIRPORT_LAND_KM, longitude, latitude))
	);
}

/** Every ring in the source, outer and hole alike, flattened. Winding is not tracked and
 *  does not need to be: `land.ts` fills with `evenodd`, so a lake drawn in the same path
 *  as the land around it cuts itself out. */
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

function boundsOf(ring) {
	let west = Infinity;
	let east = -Infinity;
	let south = Infinity;
	let north = -Infinity;
	for (const [longitude, latitude] of ring) {
		if (longitude < west) west = longitude;
		if (longitude > east) east = longitude;
		if (latitude < south) south = latitude;
		if (latitude > north) north = latitude;
	}
	return { west, south, east, north };
}

/** Whether `point` is inside `ring`, by ray casting. Used only to audit that every airport
 *  still stands on land once the simplifier has finished with it. */
function ringContains(ring, longitude, latitude) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if (yi > latitude !== yj > latitude) {
			if (longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) inside = !inside;
		}
	}
	return inside;
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
	const airports = JSON.parse(await readFile(AIRPORTS_PATH, 'utf-8'));
	const grid = bucketAirports(airports);

	const source = await loadSource(argValue('--input'));
	const sourceRings = ringsOf(source);
	const sourceVertices = sourceRings.reduce((total, ring) => total + ring.length, 0);
	console.log(`${sourceRings.length} rings, ${sourceVertices} vertices in the source`);

	const kept = [];
	for (const ring of sourceRings) {
		const area = Math.abs(ringAreaKm2(ring));
		const big = area >= ALWAYS_KEEP_AREA_KM2;
		const inhabited = big || standsOnRing(grid, ring, area);
		if (!inhabited) continue;
		const tolerance = Math.min(COARSE_TOLERANCE_KM2, Math.max(area / VERTEX_BUDGET, 1e-6));
		const simplified = simplifyRing(ring, () => tolerance);
		if (simplified.length < 4) continue;
		kept.push({ ring: simplified, area, big, tolerance, sourceVertices: ring.length });
	}
	const outputVertices = kept.reduce((total, entry) => total + entry.ring.length, 0);
	const bigOnes = kept.filter((e) => e.big);
	console.log(`  ${bigOnes.length} kept for area (${bigOnes.reduce((t, e) => t + e.ring.length, 0)} vertices), ${kept.length - bigOnes.length} for an airport (${outputVertices - bigOnes.reduce((t, e) => t + e.ring.length, 0)} vertices)`);
	console.log(
		`${kept.length} rings kept, ${outputVertices} vertices (${((outputVertices / sourceVertices) * 100).toFixed(1)}% of the source)`
	);

	const encoded = kept
		.map((entry) =>
			encodeRing(
				entry.ring.map(([longitude, latitude]) => [
					Math.round(longitude / GRID_DEGREES),
					Math.round(latitude / GRID_DEGREES)
				])
			)
		)
		.join(RING_SEPARATOR);
	const gzipped = gzipSync(Buffer.from(encoded), { level: 9 }).length;
	console.log(`encoded ${encoded.length} bytes, ${gzipped} gzipped`);

	// The invariant #346 turns on: every airport this app can route to has to stand on land
	// that survived. An island dropped here is a traveller's origin dot floating in white.
	const stranded = [];
	for (const airport of airports) {
		const candidates = kept.filter((entry) => {
			const b = boundsOf(entry.ring);
			return (
				airport.longitude >= b.west - 0.5 &&
				airport.longitude <= b.east + 0.5 &&
				airport.latitude >= b.south - 0.5 &&
				airport.latitude <= b.north + 0.5
			);
		});
		if (candidates.some((entry) => ringContains(entry.ring, airport.longitude, airport.latitude))) {
			continue;
		}
		const distance = candidates.length
			? Math.min(
					...candidates.map((entry) =>
						distanceToRingKm(entry.ring, airport.longitude, airport.latitude)
					)
				)
			: Infinity;
		stranded.push({ airport, distance });
	}
	// How far the outline that ships moves a coast, against the source it came from, at the
	// airports where it matters. `land.ts` reads the 75th percentile of this to decide when
	// a window is too narrow for a coast to be worth drawing into, and a number copied by
	// hand into that file is a number that goes quietly wrong the next time this is rerun.
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
		// Inland airports say nothing about coastline placement, and there are three of them
		// for every coastal one, so including them would report a median of zero.
		if (sourceDistance > COASTAL_AIRPORT_KM) continue;
		const fromOutput = near(kept.map((entry) => entry.ring));
		const outputDistance = fromOutput.length
			? Math.min(
					...fromOutput.map((ring) => distanceToRingKm(ring, airport.longitude, airport.latitude))
				)
			: Infinity;
		displacements.push(Math.abs(outputDistance - sourceDistance));
	}
	displacements.sort((a, b) => a - b);
	const percentile = (fraction) => displacements[Math.floor(displacements.length * fraction)];
	const displacementP75 = Math.round(percentile(0.75) * 10) / 10;
	console.log(
		`coastline displacement at ${displacements.length} coastal airports: median ${percentile(0.5).toFixed(1)} km, p75 ${displacementP75} km`
	);

	stranded.sort((a, b) => b.distance - a.distance);
	const adrift = stranded.filter((entry) => entry.distance > AIRPORT_LAND_KM);
	console.log(
		`${stranded.length} airports fall outside a kept ring, ${adrift.length} of them by more than ${AIRPORT_LAND_KM} km`
	);
	console.log(
		`worst: ${adrift
			.slice(0, 6)
			.map((s) => `${s.airport.iataCode} ${s.distance === Infinity ? 'no land' : `${s.distance.toFixed(0)}km`}`)
			.join(', ')}`
	);

	if (process.argv.includes('--dry-run')) return;

	const audit = [
		['ring', 'points_in', 'points_out', 'area_km2', 'tolerance_km2', 'kept_for', 'west', 'south', 'east', 'north'].join('\t')
	];
	kept.forEach((entry, index) => {
		const b = boundsOf(entry.ring);
		audit.push(
			[
				index,
				entry.sourceVertices,
				entry.ring.length,
				Math.round(entry.area),
				entry.tolerance.toFixed(2),
				entry.big ? 'area' : 'airport',
				b.west.toFixed(3),
				b.south.toFixed(3),
				b.east.toFixed(3),
				b.north.toFixed(3)
			].join('\t')
		);
	});
	audit.push('');
	audit.push(
		`#displacement\tmedian ${percentile(0.5).toFixed(2)} km\tp75 ${displacementP75} km\tover ${displacements.length} coastal airports`
	);
	audit.push('');
	audit.push(['#stranded', 'iata', 'name', 'km_to_nearest_kept_land'].join('\t'));
	for (const entry of stranded) {
		audit.push(
			[
				'#stranded',
				entry.airport.iataCode,
				entry.airport.name,
				entry.distance === Infinity ? 'no land within half a degree' : entry.distance.toFixed(2)
			].join('\t')
		);
	}

	const module = `// Generated by scripts/prepare-coastline.mjs. Do not edit.
//
// Natural Earth 1:10m land, public domain, simplified to about ${Math.round(Math.sqrt(2 * COARSE_TOLERANCE_KM2))} km of shape on a
// continent and to a ${VERTEX_BUDGET}-vertex budget on an island small enough to need one. Rings under
// ${ALWAYS_KEEP_AREA_KM2} km² are dropped unless an airport stands on one, or within ${AIRPORT_LAND_KM} km of one over ${ISLAND_MIN_AREA_KM2} km².
//
// ${kept.length} rings and ${outputVertices} vertices, from ${sourceRings.length} and ${sourceVertices}.
// Every ring is listed in coastline.audit.tsv; scripts/prepare-coastline.mjs says why.

/** Degrees per step of the integer grid the rings are quantised to. */
export const COASTLINE_GRID_DEGREES = ${GRID_DEGREES};

/**
 * How far this outline moves a coast from where its source puts it, in kilometres, at the
 * 75th percentile over the ${displacements.length} airports within ${COASTAL_AIRPORT_KM} km of a shore.
 *
 * Measured against the rings below rather than inferred from the tolerance they were
 * simplified with, because the two differ by a factor of four: simplification erases
 * features up to about ${Math.round(Math.sqrt(2 * COARSE_TOLERANCE_KM2))} km across, but every vertex it keeps is an exact source
 * point, so a smooth coast between two of them barely moves. \`land.ts\` sizes its
 * draw-or-fill threshold on this.
 */
export const COASTLINE_DISPLACEMENT_KM = ${displacementP75};

/** Rings separated by a space, each one polyline-encoded grid steps. */
export const COASTLINE_RINGS =
\t'${encoded}';
`;

	await writeFile(OUTPUT_PATH, module);
	await writeFile(AUDIT_PATH, `${audit.join('\n')}\n`);
	console.log(`wrote ${OUTPUT_PATH}`);
	console.log(`wrote ${AUDIT_PATH}`);
}

await main();
