#!/usr/bin/env node
// Rebuilds src/lib/data/airports.generated.json from the OurAirports CSV.
//
// The 12 MB source (https://davidmegginson.github.io/ourairports-data/airports.csv,
// public domain) is far too large to ship to a phone, and most of it is closed strips
// and private helipads a flight search never touches. This keeps only airports with an
// IATA code and scheduled service, and only the fields the app reads.
//
// Run manually with `pnpm run data:airports` when the upstream data changes. The output
// is committed so `pnpm build` never depends on a third-party CDN being up.
//
// Usage: node scripts/prepare-airports.mjs [--input <path-to-local-csv>]

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const OUTPUT_PATH = fileURLToPath(
	new URL('../src/lib/data/airports.generated.json', import.meta.url)
);

/**
 * Minimal RFC 4180 CSV parser. OurAirports quotes every field and doubles embedded
 * quotes, and airport names sometimes contain commas ("Bogotá, El Dorado" style), so a
 * naive `split(',')` silently misaligns columns. This is small enough not to warrant a
 * dependency.
 */
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];

		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += c;
			}
			continue;
		}

		if (c === '"') {
			inQuotes = true;
		} else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\r') {
			// swallow, \n handles the line break
		} else if (c === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else {
			field += c;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function rowsToObjects(rows) {
	const [header, ...body] = rows;
	return body
		.filter((r) => r.length === header.length)
		.map((r) => Object.fromEntries(header.map((key, i) => [key, r[i]])));
}

async function loadCsvText(inputPath) {
	if (inputPath) {
		const { readFile } = await import('node:fs/promises');
		return readFile(inputPath, 'utf-8');
	}
	const res = await fetch(SOURCE_URL);
	if (!res.ok) {
		throw new Error(`Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`);
	}
	return res.text();
}

function toCompactAirport(row) {
	const iataCode = row.iata_code?.trim();
	if (!iataCode) return null;

	const latitude = Number.parseFloat(row.latitude_deg);
	const longitude = Number.parseFloat(row.longitude_deg);
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

	return {
		iataCode,
		// A handful of scheduled-service airports have no assigned ICAO code in
		// OurAirports (mostly small US/Pacific strips). Keep that absence explicit
		// rather than guessing.
		icaoCode: row.icao_code?.trim() || null,
		name: row.name?.trim() || iataCode,
		// municipality is blank for a small number of rows (e.g. airports named after
		// the city already). Falling back to the airport name keeps search working.
		city: row.municipality?.trim() || row.name?.trim() || iataCode,
		countryCode: row.iso_country?.trim() || '',
		latitude,
		longitude,
		// Raw OurAirports type (e.g. "large_airport"), the input to deriveSizeClass in
		// src/lib/data/airports.ts. Kept as-is rather than pre-computing a size class so
		// the derivation stays a testable pure function instead of baked-in data.
		type: row.type?.trim() || ''
	};
}

async function main() {
	const inputFlagIndex = process.argv.indexOf('--input');
	const inputPath = inputFlagIndex !== -1 ? process.argv[inputFlagIndex + 1] : undefined;

	const csvText = await loadCsvText(inputPath);
	const rows = rowsToObjects(parseCsv(csvText));

	const airports = rows
		.filter((row) => row.scheduled_service === 'yes')
		.map(toCompactAirport)
		.filter((a) => a !== null)
		.sort((a, b) => a.iataCode.localeCompare(b.iataCode));

	const json = JSON.stringify(airports);
	await writeFile(OUTPUT_PATH, json);

	const bytes = Buffer.byteLength(json, 'utf-8');
	console.log(
		`Wrote ${airports.length} airports (${(bytes / 1024).toFixed(1)} KB) to ${OUTPUT_PATH}`
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
