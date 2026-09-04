#!/usr/bin/env node
// Issue #52: fetches Travelpayouts city-directions cheap routes for a configured
// list of origins (scripts/cheap-routes.config.mjs) and compiles them into static
// JSON, the same build-time pattern scripts/prepare-airports.mjs already uses for
// the OurAirports CSV.
//
// That pattern is the whole point: docs/PROVIDERS.md found real cached fares
// behind this endpoint but no CORS headers at all, so the browser cannot call it
// (a live fetch() from the deployed site throws `TypeError: Failed to fetch`).
// The no-backend rule bans a server at *runtime*, not a build step, so this runs
// server-side in CI, on a schedule (.github/workflows/cheap-routes.yml), and the
// app reads the resulting file as a static asset.
//
// Every price this endpoint returns is a recently cached fare, not a live
// search, and comes with its own `expires_at`. That is kept verbatim through to
// the generated JSON and from there into src/lib/data/cheap-routes.ts's exported
// type, so nothing downstream can show one of these prices without also knowing
// how old it is (AGENTS.md: "never present an estimate as a fact").
//
// The token (TRAVELPAYOUTS_TOKEN) is read once from the environment and used
// only inside a URL object's query string, in memory, immediately before each
// fetch() call. It is never written to a file and every console line below is
// passed through redact() first -- deliberately, since this API takes the token
// as a query parameter, which leaks into logs far more easily than a header
// would (e.g. a thrown request URL, a proxy access log).
//
// Usage: TRAVELPAYOUTS_TOKEN=xxx node scripts/fetch-cheap-routes.mjs

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ORIGINS } from './cheap-routes.config.mjs';
import { parseCityDirectionsResponse } from './cheap-routes-parser.mjs';

const OUTPUT_PATH = fileURLToPath(
	new URL('../src/lib/data/cheap-routes.generated.json', import.meta.url)
);
const API_BASE = 'https://api.travelpayouts.com/v1/city-directions';

function requireToken() {
	const token = process.env.TRAVELPAYOUTS_TOKEN;
	if (!token) {
		throw new Error(
			'TRAVELPAYOUTS_TOKEN is not set. CI reads it from the repository secret; set it in ' +
				'your own shell to run this locally.'
		);
	}
	return token;
}

/** Strips the token out of any string before it can reach stdout/stderr. Belt
 * and braces alongside GitHub Actions' own secret masking: this also protects a
 * local run, where nothing masks the terminal. */
function makeRedactor(token) {
	return (value) => (typeof value === 'string' ? value.split(token).join('[REDACTED]') : value);
}

async function fetchOrigin(origin, token) {
	const url = new URL(API_BASE);
	url.searchParams.set('origin', origin);
	url.searchParams.set('currency', 'eur');
	url.searchParams.set('token', token);

	const res = await fetch(url);
	if (!res.ok) {
		// Deliberately omit the URL/body here: a token-bearing query string on a
		// failed request is exactly the case redact() exists for, but the
		// simplest guarantee is to just never build the message from them.
		throw new Error(`Travelpayouts returned ${res.status} ${res.statusText} for origin ${origin}`);
	}

	const json = await res.json();
	return parseCityDirectionsResponse(origin, json);
}

async function main() {
	const token = requireToken();
	const redact = makeRedactor(token);

	const allRoutes = [];
	const failedOrigins = [];

	for (const origin of ORIGINS) {
		console.log(`Fetching cheap routes for ${origin}...`);
		try {
			const routes = await fetchOrigin(origin, token);
			console.log(`  ${routes.length} routes`);
			allRoutes.push(...routes);
		} catch (err) {
			failedOrigins.push(origin);
			console.error(redact(err instanceof Error ? err.message : String(err)));
		}
	}

	if (failedOrigins.length > 0) {
		// A partial fetch must never silently overwrite good, previously-committed
		// data with an incomplete dataset -- fail the whole job instead. The
		// scheduled workflow just tries again tomorrow night.
		throw new Error(`Failed to fetch cheap routes for: ${failedOrigins.join(', ')}`);
	}

	// Sorted for a stable diff: the same underlying data should produce the same
	// byte-for-byte file, so "commit only when changed" (issue #52) actually
	// means changed data, not object-key reordering.
	allRoutes.sort(
		(a, b) => a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination)
	);

	const json = JSON.stringify(allRoutes);
	await writeFile(OUTPUT_PATH, json);

	const bytes = Buffer.byteLength(json, 'utf-8');
	console.log(
		`Wrote ${allRoutes.length} cheap routes (${(bytes / 1024).toFixed(1)} KB) to ${OUTPUT_PATH}`
	);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
