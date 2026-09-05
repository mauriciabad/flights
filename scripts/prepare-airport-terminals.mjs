#!/usr/bin/env node
// Rebuilds src/lib/data/airport-terminals.generated.json and its audit file from
// OpenStreetMap (issue #341).
//
// Why this exists: every ground transfer the app plans starts or ends at
// `Airport.coordinates`, and that is the runway reference point, not a door. At London
// Gatwick the two are 1.4 km apart and on opposite sides of the airfield, so OSRM was asked
// to walk to a Horley hotel from a spot 300 m off the nearest footpath on the south-west
// perimeter. It answered 5.46 km and 1h 13m, the 45-minute plausibility cap threw that away,
// and the traveller was shown a two-bus journey with a change and no walking option at all.
// From the North Terminal the same walk is 2.42 km and 32 minutes. The owner said "arround
// 30 mins", and he was measuring from where a person actually stands.
//
// So the cap was never the bug. It refused a walk nobody would take, from a place nobody
// starts. This table moves the start.
//
// Source: the Overpass API, `aeroway=terminal` worldwide, ODbL. Keyless, and one request
// for the whole planet rather than 4,133 — that query is expensive for a volunteer-run
// service and this script is why it only has to run when the upstream data changes, like
// `pnpm run data:airports`. The output is committed so `pnpm build` never depends on it.
//
// The rule that accepts a row lives in terminal-match.mjs and is separately tested. Every
// accepted row names the OSM element it came from and how far that element moved the
// airport, in src/lib/data/airport-terminals.audit.tsv, so any single entry can be
// re-checked at openstreetmap.org without re-running anything.
//
// Usage:
//   node scripts/prepare-airport-terminals.mjs [--input <overpass.json>] [--verify]

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
	chooseTerminal,
	haversineKm,
	isPassengerTerminal,
	MAX_TERMINAL_DISTANCE_KM
} from './terminal-match.mjs';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_QUERY = '[out:json][timeout:600];nwr["aeroway"="terminal"];out center tags;';

const AIRPORTS_PATH = fileURLToPath(
	new URL('../src/lib/data/airports.generated.json', import.meta.url)
);
const OUTPUT_PATH = fileURLToPath(
	new URL('../src/lib/data/airport-terminals.generated.json', import.meta.url)
);
const AUDIT_PATH = fileURLToPath(
	new URL('../src/lib/data/airport-terminals.audit.tsv', import.meta.url)
);

/** Overpass returns a `center` for ways and relations and bare `lat`/`lon` for nodes. */
function coordinatesOf(element) {
	const centre = element.center ?? element;
	if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) return null;
	return { latitude: centre.lat, longitude: centre.lon };
}

function toTerminal(element) {
	const point = coordinatesOf(element);
	if (!point) return null;
	const tags = element.tags ?? {};
	const terminal = {
		id: `${element.type}/${element.id}`,
		name: tags.name ?? tags['name:en'] ?? '',
		nameEn: tags['name:en'],
		building: tags.building,
		...point
	};
	return isPassengerTerminal(terminal) ? terminal : null;
}

/**
 * Half-degree buckets, so matching 4,133 airports against 10,000 terminals is a scan of the
 * nine cells around each airport instead of the whole planet. Half a degree of latitude is
 * 55 km, comfortably wider than `MAX_TERMINAL_DISTANCE_KM`, so a terminal inside the radius
 * is always in one of those nine.
 */
function bucketise(terminals) {
	const grid = new Map();
	for (const terminal of terminals) {
		const key = `${Math.round(terminal.latitude * 2)}:${Math.round(terminal.longitude * 2)}`;
		const cell = grid.get(key);
		if (cell) cell.push(terminal);
		else grid.set(key, [terminal]);
	}
	return grid;
}

function cellsAround(grid, point) {
	const found = [];
	const lat = Math.round(point.latitude * 2);
	const lon = Math.round(point.longitude * 2);
	for (let dLat = -1; dLat <= 1; dLat++) {
		for (let dLon = -1; dLon <= 1; dLon++) {
			found.push(...(grid.get(`${lat + dLat}:${lon + dLon}`) ?? []));
		}
	}
	return found;
}

/**
 * Gives every terminal to its own nearest airport before any airport is allowed to claim
 * one.
 *
 * Without this, two fields sharing a city trade buildings: London City and Biggin Hill are
 * 13 km apart, and a 6 km radius drawn around each would let the wrong one answer for the
 * other's terminal whenever the true one is unmapped. Ownership is a property of the
 * terminal, so it is decided once, from the terminal's side.
 */
function assignTerminalsToAirports(airports, terminals) {
	const grid = bucketise(airports);
	const owned = new Map();
	for (const terminal of terminals) {
		let nearest = null;
		for (const airport of cellsAround(grid, terminal)) {
			const km = haversineKm(terminal, airport);
			if (km > MAX_TERMINAL_DISTANCE_KM) continue;
			if (!nearest || km < nearest.km) nearest = { airport, km };
		}
		if (!nearest) continue;
		const list = owned.get(nearest.airport.iataCode);
		if (list) list.push(terminal);
		else owned.set(nearest.airport.iataCode, [terminal]);
	}
	return owned;
}

async function fetchTerminals(inputPath) {
	if (inputPath) return JSON.parse(await readFile(inputPath, 'utf-8'));
	const response = await fetch(OVERPASS_URL, {
		method: 'POST',
		body: new URLSearchParams({ data: OVERPASS_QUERY })
	});
	if (!response.ok) {
		throw new Error(`Overpass answered ${response.status} ${response.statusText}`);
	}
	const text = await response.text();
	// Overpass reports a busy dispatcher as an HTML page with a 200, so a JSON parse
	// failure here is the expected shape of "try again later", not a corrupt download.
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Overpass did not return JSON. First 200 characters:\n${text.slice(0, 200)}`);
	}
}

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
	const airports = JSON.parse(await readFile(AIRPORTS_PATH, 'utf-8'));
	const body = await fetchTerminals(argValue('--input'));
	const terminals = (body.elements ?? []).map(toTerminal).filter(Boolean);
	console.log(`${terminals.length} passenger terminals from ${body.elements?.length ?? 0} elements`);

	const owned = assignTerminalsToAirports(airports, terminals);

	const table = {};
	const audit = [
		['iata', 'airport', 'osm', 'terminal', 'km_from_published_point', 'latitude', 'longitude'].join(
			'\t'
		)
	];
	let considered = 0;
	for (const airport of airports) {
		const candidates = owned.get(airport.iataCode);
		if (!candidates) continue;
		considered++;
		const chosen = chooseTerminal(airport, candidates);
		if (!chosen) continue;
		// Already rounded by `chooseTerminal`, which measures the shift against the value
		// that ships rather than the one Overpass sent.
		const { latitude, longitude } = chosen;
		table[airport.iataCode] = [latitude, longitude];
		audit.push(
			[
				airport.iataCode,
				airport.name,
				chosen.terminal.id,
				chosen.terminal.name || '(unnamed)',
				chosen.km.toFixed(2),
				latitude,
				longitude
			].join('\t')
		);
	}

	const accepted = Object.keys(table).length;
	console.log(
		`${accepted} airports moved to a terminal; ${considered - accepted} already had one within ${
			MAX_TERMINAL_DISTANCE_KM
		} km of the published point but closer than the shift floor`
	);

	if (process.argv.includes('--verify')) return;

	// Sorted so a rerun that changes nothing produces no diff.
	const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
	await writeFile(OUTPUT_PATH, `${JSON.stringify(sorted)}\n`);
	await writeFile(AUDIT_PATH, `${audit.join('\n')}\n`);
	console.log(`wrote ${OUTPUT_PATH}`);
	console.log(`wrote ${AUDIT_PATH}`);
}

await main();
