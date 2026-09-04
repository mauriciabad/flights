#!/usr/bin/env node
// Issue #121: snapshots Ryanair's whole route graph and its airport timezone table
// into static JSON, the same build-time pattern scripts/fetch-cheap-routes.mjs uses
// for Travelpayouts and scripts/prepare-airports.mjs uses for the OurAirports CSV.
//
// Unlike Travelpayouts, this endpoint is CORS-open and the browser CAN call it, so
// this script is not about reachability. It is about cost. Before this file existed,
// one indirect search asked Ryanair "what does airport X fly to" once per candidate
// airport -- 80 requests to
// /api/views/locate/searchWidget/routes/en/airport/{IATA} for a single BCN->OTP
// search, measured 2026-09-04. Shipping the answer with the app makes that number
// zero on a cold cache, and the runtime adapter still refreshes it from the live
// endpoint once a day (src/lib/providers/flights/ryanair.ts).
//
// The single endpoint below carries the entire network. Verified 2026-09-04: for BCN
// its `routes` array yields exactly the same 64 destination codes as the per-airport
// endpoint returns, and the airports Ryanair does not serve at all (ALG, DUS, EVN,
// IST, LED) are simply absent from it -- which is the same fact the per-airport
// endpoint spends a 404 to state. So one 278 KB response replaces 224 of them.
//
// Keyless: no token, no secret, nothing to redact. Runs weekly in CI
// (.github/workflows/ryanair-network.yml) because an airline's route network moves
// seasonally, not hourly.
//
// Usage: node scripts/fetch-ryanair-network.mjs

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUTPUT_PATH = fileURLToPath(
	new URL('../src/lib/data/ryanair-network.generated.json', import.meta.url)
);
const ACTIVE_AIRPORTS_URL = 'https://www.ryanair.com/api/views/locate/3/airports/en/active';

/** Ryanair writes an airport edge as `airport:STN`. The same `routes` array also holds
 * `city:`, `country:`, `region:` and `connectingFlight:` entries, which are search-widget
 * facets rather than routes to a specific airport, so only the `airport:` prefix is a
 * destination this app can ask a fare provider about. */
const AIRPORT_ROUTE_PREFIX = 'airport:';

// A few entries carry a marketing carrier after a pipe -- `airport:PMO|Air Malta` on the
// Malta-Palermo pair, the only two in the feed on 2026-09-04. It is an annotation, not a
// different route: the per-airport endpoint reports that leg with `operator: "FR"` and no
// marker, and the feed lists a plain `airport:PMO` next to it, so the Set below collapses
// the pair. Kept in step with `iataCodeOf` in src/lib/providers/flights/ryanair-mapper.ts,
// which does the same thing for the live refresh; src/lib/data/ryanair-network.test.ts
// fails if the two derivations drift.
function iataCodeOf(entry) {
	return entry.slice(AIRPORT_ROUTE_PREFIX.length).split('|')[0];
}

function destinationsOf(airport) {
	// `seasonalRoutes` is present on every airport and empty on every one of them
	// (checked across all 224, 2026-09-04); `routes` already includes the destinations
	// the per-airport endpoint marks seasonal. Unioned anyway so the day Ryanair starts
	// populating it, a seasonal route appears here instead of silently disappearing.
	const raw = [...(airport.routes ?? []), ...(airport.seasonalRoutes ?? [])];
	const codes = new Set();
	for (const entry of raw) {
		if (typeof entry === 'string' && entry.startsWith(AIRPORT_ROUTE_PREFIX)) {
			codes.add(iataCodeOf(entry));
		}
	}
	// Sorted for a stable diff: the same network should produce the same bytes, so
	// "commit only when changed" means changed routes, not a reordered array.
	return [...codes].sort();
}

async function main() {
	const response = await fetch(ACTIVE_AIRPORTS_URL);
	if (!response.ok) {
		throw new Error(
			`Ryanair returned ${response.status} ${response.statusText} for ${ACTIVE_AIRPORTS_URL}`
		);
	}

	const airports = await response.json();
	if (!Array.isArray(airports) || airports.length === 0) {
		throw new Error('Ryanair returned no active airports; refusing to overwrite the snapshot');
	}

	const destinationsByOrigin = {};
	const timeZonesByIataCode = {};
	for (const airport of airports) {
		if (typeof airport?.iataCode !== 'string' || !airport.iataCode) continue;
		destinationsByOrigin[airport.iataCode] = destinationsOf(airport);
		if (typeof airport.timeZone === 'string' && airport.timeZone) {
			timeZonesByIataCode[airport.iataCode] = airport.timeZone;
		}
	}

	const origins = Object.keys(destinationsByOrigin).sort();
	const edges = origins.reduce((n, code) => n + destinationsByOrigin[code].length, 0);
	if (origins.length < 100 || edges < 1000) {
		// A truncated or reshaped response must never silently replace a good snapshot
		// with a half-empty one -- the app would then report "Ryanair does not serve that
		// airport" for most of Europe. Fail the job; the weekly run tries again.
		throw new Error(
			`Snapshot looks truncated: ${origins.length} airports, ${edges} routes. Refusing to write.`
		);
	}

	const snapshot = {
		fetchedAt: new Date().toISOString(),
		destinationsByOrigin: Object.fromEntries(
			origins.map((code) => [code, destinationsByOrigin[code]])
		),
		timeZonesByIataCode: Object.fromEntries(
			Object.keys(timeZonesByIataCode)
				.sort()
				.map((code) => [code, timeZonesByIataCode[code]])
		)
	};

	const json = JSON.stringify(snapshot);
	await writeFile(OUTPUT_PATH, json);

	const bytes = Buffer.byteLength(json, 'utf-8');
	console.log(
		`Wrote ${origins.length} Ryanair airports and ${edges} routes (${(bytes / 1024).toFixed(1)} KB) to ${OUTPUT_PATH}`
	);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
