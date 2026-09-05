#!/usr/bin/env node
// Rebuilds src/lib/data/city-centres.generated.json and its audit file from GeoNames
// (issue #198).
//
// Why this exists: `Airport.city.coordinates` is what the app routes a stopover transfer
// to and what it measures "N km from the city centre" against, and before this it came
// from a hand-checked table of eleven airports. London Gatwick was not one of them, so on
// the one trip docs/ACCEPTANCE.md uses to decide whether the app works, the feature the
// whole product is named for rendered as two empty rows.
//
// The issue offered two answers: extend the table, or find a keyless source that can be
// VERIFIED rather than trusted. This is the second. Every accepted row names the GeoNames
// record it came from, how far that record is from the runway, and which of the airport's
// names matched — see src/lib/data/city-centres.audit.tsv — so any single entry can be
// re-checked without re-running anything.
//
// The hand-checked eleven are NOT replaced. They stay in `airport-city-names.ts` and win,
// and they are what verifies this script: run with `--verify` and it reports how far each
// generated answer lands from the hand-checked one for the airports that have both.
//
// This is a build step, not a runtime call. The no-backend rule bans a server when the app
// runs, not a script that commits a static asset; `.github/workflows/cheap-routes.yml`
// makes the same trade for the same reason. Unlike that one there is no schedule here,
// because city centres do not move. Run it by hand, like `pnpm run data:airports`.
//
// Source: https://download.geonames.org/export/dump/cities1000.zip, every populated place
// with more than 1,000 inhabitants, CC BY 4.0. The 1,000 cut is deliberate: below it the
// remaining airports are ice strips and atolls that are never anybody's stopover, and the
// download doubles.
//
// Needs a Node that strips TypeScript types (22.18+, or 23 and up). It imports the real
// `airport-city-names.ts` rather than copying `cleanMunicipality` and the curated table,
// because that file's own header says why two lists that have to agree is the bug.
//
// Usage:
//   node scripts/prepare-city-centres.mjs [--input <cities1000.zip>] [--verify]

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import {
	chooseCityCentre,
	haversineKm,
	MAX_CENTRE_DISTANCE_KM,
	normalizeCityName,
	roundCoordinate
} from './city-centre-match.mjs';

const SOURCE_URL = 'https://download.geonames.org/export/dump/cities1000.zip';
const ENTRY_NAME = 'cities1000.txt';
const AIRPORTS_PATH = fileURLToPath(
	new URL('../src/lib/data/airports.generated.json', import.meta.url)
);
const OUTPUT_PATH = fileURLToPath(
	new URL('../src/lib/data/city-centres.generated.json', import.meta.url)
);
const AUDIT_PATH = fileURLToPath(new URL('../src/lib/data/city-centres.audit.tsv', import.meta.url));

const { cleanMunicipality, cityCentreOf, displayCityName } = await import(
	'../src/lib/data/airport-city-names.ts'
);

/**
 * Reads one deflated entry out of a zip, via the central directory rather than the local
 * file header. GeoNames writes its archives with the streaming bit set, so the local
 * header carries zeroes for both sizes and reading them gives an empty buffer that
 * `inflateRawSync` rejects as a truncated stream. The central directory always has the
 * real ones. Small enough not to warrant a dependency, the same call
 * `prepare-airports.mjs` made about its CSV parser.
 */
function readZipEntry(buffer, wantedName) {
	const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
	const CENTRAL_FILE_HEADER = 0x02014b50;

	let eocd = -1;
	// The record is last, but a zip comment can follow it, and a comment is capped at 64 KB.
	for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 0xffff; i--) {
		if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
			eocd = i;
			break;
		}
	}
	if (eocd === -1) throw new Error('Not a zip file: no end-of-central-directory record');

	let offset = buffer.readUInt32LE(eocd + 16);
	const entries = buffer.readUInt16LE(eocd + 10);
	for (let n = 0; n < entries; n++) {
		if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
			throw new Error('Corrupt zip: central directory entry has the wrong signature');
		}
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

		if (name === wantedName) {
			const dataStart =
				localOffset +
				30 +
				buffer.readUInt16LE(localOffset + 26) +
				buffer.readUInt16LE(localOffset + 28);
			const raw = buffer.subarray(dataStart, dataStart + compressedSize);
			if (method === 0) return Buffer.from(raw);
			if (method === 8) return inflateRawSync(raw, { maxOutputLength: 400_000_000 });
			throw new Error(`Unsupported zip compression method ${method} for ${wantedName}`);
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	throw new Error(`Zip has no entry named ${wantedName}`);
}

async function loadArchive(inputPath) {
	if (inputPath) return readFile(inputPath);
	const res = await fetch(SOURCE_URL);
	if (!res.ok) throw new Error(`Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`);
	return Buffer.from(await res.arrayBuffer());
}

/** GeoNames' tab-separated columns, only the ones this rule reads. */
function parseRow(line) {
	const f = line.split('\t');
	const countryCode = f[8];
	const latitude = Number(f[4]);
	const longitude = Number(f[5]);
	if (!countryCode || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
	return {
		countryCode,
		place: { id: f[0], name: f[1], latitude, longitude, population: Number(f[14]) || 0 },
		names: [f[1], f[2]],
		alternateNames: f[3] ? f[3].split(',') : []
	};
}

/**
 * The airport's names, best first. The name the app PRINTS leads, because that is this
 * codebase's own answer to "what city is this airport for", and `chooseCityCentre` is
 * built to let it win over a nearer municipality. See that function for what happens
 * without it.
 */
function airportNameTiers(airport) {
	const tiers = [
		displayCityName(airport.iataCode, airport.city),
		cleanMunicipality(airport.city),
		airport.city
	].map(normalizeCityName);
	// Deduplicated in order: for the ~99% of airports with no curated name all three are
	// the same string, and an empty later tier is cheaper than three identical lookups.
	const seen = new Set();
	return tiers.map((name) => {
		if (!name || seen.has(name)) return '';
		seen.add(name);
		return name;
	});
}

function addToIndex(index, countryCode, name, place) {
	const key = normalizeCityName(name);
	if (!key) return;
	let byName = index.get(countryCode);
	if (!byName) index.set(countryCode, (byName = new Map()));
	const bucket = byName.get(key);
	if (bucket) bucket.push(place);
	else byName.set(key, [place]);
}

function lookupTiers(index, airport, tiers) {
	const byName = index.get(airport.countryCode);
	if (!byName) return tiers.map(() => []);
	return tiers.map((name) => (name ? (byName.get(name) ?? []) : []));
}

async function main() {
	const inputFlag = process.argv.indexOf('--input');
	const inputPath = inputFlag !== -1 ? process.argv[inputFlag + 1] : undefined;
	const verify = process.argv.includes('--verify');

	const archive = await loadArchive(inputPath);
	const lines = readZipEntry(archive, ENTRY_NAME).toString('utf8').split('\n');
	const airports = JSON.parse(await readFile(AIRPORTS_PATH, 'utf-8'));

	// Pass one: the place's own name and its ASCII form. This is the match a reviewer can
	// read straight off the row.
	const nameIndex = new Map();
	let placeCount = 0;
	for (const line of lines) {
		const row = parseRow(line);
		if (!row) continue;
		placeCount += 1;
		for (const name of new Set(row.names)) addToIndex(nameIndex, row.countryCode, name, row.place);
	}

	const tiersByAirport = new Map(airports.map((a) => [a.iataCode, airportNameTiers(a)]));
	const chosen = new Map();
	const unresolved = [];
	for (const airport of airports) {
		const tiers = tiersByAirport.get(airport.iataCode);
		const hit = chooseCityCentre(airport, lookupTiers(nameIndex, airport, tiers));
		if (hit) chosen.set(airport.iataCode, { ...hit, via: 'name' });
		else unresolved.push(airport);
	}
	const matchedOnName = chosen.size;

	// Pass two, for the airports pass one could not place: GeoNames' `alternatenames`
	// column, which is where "Aarhus" lives for the record named "Århus" and "St. Gallen"
	// for "Sankt Gallen". Only the names an unresolved airport is actually asking for get
	// indexed — the full column is tens of millions of strings and this keeps the pass to
	// the few thousand that can change an answer.
	const wanted = new Map();
	for (const airport of unresolved) {
		let set = wanted.get(airport.countryCode);
		if (!set) wanted.set(airport.countryCode, (set = new Set()));
		for (const name of tiersByAirport.get(airport.iataCode)) if (name) set.add(name);
	}
	const alternateIndex = new Map();
	for (const line of lines) {
		const row = parseRow(line);
		if (!row) continue;
		const want = wanted.get(row.countryCode);
		if (!want) continue;
		for (const alternate of row.alternateNames) {
			if (want.has(normalizeCityName(alternate))) {
				addToIndex(alternateIndex, row.countryCode, alternate, row.place);
			}
		}
	}
	const stillMissing = [];
	for (const airport of unresolved) {
		const tiers = tiersByAirport.get(airport.iataCode);
		const hit = chooseCityCentre(airport, lookupTiers(alternateIndex, airport, tiers));
		if (hit) chosen.set(airport.iataCode, { ...hit, via: 'alternate' });
		else stillMissing.push(airport);
	}

	// Airports with a hand-checked centre are left out of the output entirely. The curated
	// value wins at read time anyway, and a generated row sitting next to it that says
	// something different is a trap for whoever reads this file next.
	const curatedCodes = new Set(airports.map((a) => a.iataCode).filter((code) => cityCentreOf(code)));

	const rows = airports
		.filter((a) => chosen.has(a.iataCode) && !curatedCodes.has(a.iataCode))
		.map((a) => ({ airport: a, hit: chosen.get(a.iataCode) }));

	const centres = Object.fromEntries(
		rows.map(({ airport, hit }) => [
			airport.iataCode,
			[roundCoordinate(hit.place.latitude), roundCoordinate(hit.place.longitude)]
		])
	);
	const json = JSON.stringify(centres);
	await writeFile(OUTPUT_PATH, json);

	const TIER_NAMES = ['displayed city', 'cleaned municipality', 'raw municipality'];
	const audit = [
		[
			'iata',
			'airportMunicipality',
			'matchedPlace',
			'geonameId',
			'country',
			'population',
			'kmFromAirport',
			'matchedName',
			'matchedVia'
		].join('\t'),
		...rows.map(({ airport, hit }) =>
			[
				airport.iataCode,
				airport.city,
				hit.place.name,
				hit.place.id,
				airport.countryCode,
				hit.place.population,
				hit.km.toFixed(1),
				TIER_NAMES[hit.tier],
				hit.via
			].join('\t')
		)
	].join('\n');
	await writeFile(AUDIT_PATH, `${audit}\n`);

	console.log(`GeoNames places read: ${placeCount}`);
	console.log(`Airports in the dataset: ${airports.length}`);
	console.log(`  matched on the place's own name: ${matchedOnName}`);
	console.log(`  matched on an alternate name:    ${chosen.size - matchedOnName}`);
	console.log(`  hand-checked already, left out:  ${curatedCodes.size}`);
	console.log(`  no centre:                       ${stillMissing.length}`);
	console.log(
		`Wrote ${rows.length} centres (${(Buffer.byteLength(json, 'utf-8') / 1024).toFixed(1)} KB) to ${OUTPUT_PATH}`
	);
	console.log(`Wrote the audit trail to ${AUDIT_PATH}`);

	if (verify) {
		console.log(
			`\nAgainst the hand-checked table, which this script never overwrites. Each row is\n` +
				`how far this rule's answer lands from a coordinate a person read off a geocoder\n` +
				`and checked by hand (airport-city-names.ts, issue #162).`
		);
		const drift = [];
		for (const airport of airports) {
			const curated = cityCentreOf(airport.iataCode);
			const hit = chosen.get(airport.iataCode);
			if (!curated) continue;
			drift.push({
				iata: airport.iataCode,
				city: airport.city,
				place: hit ? hit.place.name : null,
				km: hit ? haversineKm(curated, hit.place) : null
			});
		}
		for (const d of drift.sort((a, b) => (b.km ?? Infinity) - (a.km ?? Infinity))) {
			console.log(
				`  ${d.iata}  "${d.city}"  ${d.place ? `-> ${d.place}, ${d.km.toFixed(1)} km away` : '-> no match, the hand-checked value is the only one'}`
			);
		}
		const agreeing = drift.filter((d) => d.km !== null && d.km <= 2).length;
		console.log(
			`  ${agreeing} of ${drift.length} land within 2 km of the hand-checked point.` +
				` Cap is ${MAX_CENTRE_DISTANCE_KM} km from the runway.`
		);
	}

	if (stillMissing.length > 0) {
		const large = stillMissing.filter((a) => a.type === 'large_airport');
		console.log(`\nLargest airports still without a centre (${large.length} of ${stillMissing.length}):`);
		for (const a of large.slice(0, 12)) console.log(`  ${a.iataCode} "${a.city}" (${a.countryCode})`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
