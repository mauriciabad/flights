/**
 * The route data the app ships inside its own bundle, rewritten to say what the spec says.
 *
 * Issue #379, the `tests/e2e/` half. `pnpm qa` got this in #395 for one scenario; this suite
 * has 48 of them, so the universe is not a constant here. It is whatever airport list a spec
 * declares, and the shared fixture is only the default.
 *
 * ## What was wrong
 *
 * Every provider a spec talks to is mocked, and `network-guard.ts` blocks any host that is
 * not. But `algorithm/connections.ts` proposes stopover candidates from three sources that
 * are not providers at all: Ryanair's bundled network snapshot, the all-carrier graph
 * vendored from Wikipedia, and the cached-fare table. Those are JSON files the app reaches
 * with a plain dynamic `import()`, so they arrive as ordinary app assets and the guard
 * rightly lets them through.
 *
 * The result was a spec whose fixture named fourteen airports ranking against 224 Ryanair
 * airports and a 309-airport encyclopedia graph. #361 widened the second of those and three
 * specs broke at once: Berlin fell from a handful of candidates to tenth of 49, Boa Vista
 * gained 27 neighbours and lost its empty-state premise, and a cap spec's counts moved. None
 * of those specs had changed. Their fixtures had simply stopped describing their own
 * scenarios, and nothing could say so until the data moved underneath them.
 *
 * ## What it says now
 *
 * The airport list is the whole universe. `tests/e2e/fixtures/ryanair/active-airports.json`
 * by default, projected through the app's own `buildNetworkSnapshot`, so the graph the search
 * ranks on and the graph the provider answers with are one declaration and cannot disagree.
 * `mockRyanairNetwork` in support/providers.ts pins both from one array, which is what a spec
 * with a world of its own passes.
 *
 * Add an airport to the list and it exists. Leave it out and nothing invents it, with one
 * named exception: `FALLBACK_ROUTES` in `src/lib/algorithm/connections-fallback-data.ts` is a
 * fourth bundled source, and it is compiled into the app rather than fetched, so nothing here
 * can answer for it. That is fine and it is the reason this file names three datasets rather
 * than four. Those three are regenerated on a schedule by CI, which is how the graph widened
 * under three specs overnight; the fallback table is eighteen airports a person maintains by
 * hand and it moves when somebody moves it. `tests/e2e/bundled-route-data.spec.ts` asserts
 * against both, so the whole universe is two files a reader can open.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { buildNetworkSnapshot } from '../../../src/lib/providers/flights/ryanair-mapper';
import type {
	RyanairActiveAirport,
	RyanairActiveAirportsResponse
} from '../../../src/lib/providers/flights/ryanair-types';
import { chunkPathnames } from '../../shared/bundled-chunks';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export const DEFAULT_ACTIVE_AIRPORTS_FIXTURE = 'ryanair/active-airports.json';

/**
 * Plainly in the past, so `newerSnapshot` in ryanair-network.ts prefers the response the
 * spec's own mock just served over this one. That is what production does too, and it keeps a
 * spec that answers `active-airports` in charge of what the adapter reads.
 */
const FETCHED_AT = '2026-09-01T00:00:00.000Z';

const SOURCES = {
	ryanairNetwork: 'src/lib/data/ryanair-network.generated.json',
	directRoutes: 'src/lib/data/direct-routes.generated.json',
	cheapRoutes: 'src/lib/data/cheap-routes.generated.json'
} as const;

/**
 * The fields `buildNetworkSnapshot` actually reads, so a spec writing a network inline does
 * not have to invent a `seoName`, a currency and a pair of coordinates for an airport whose
 * only job is to exist. The fixtures on disk are full responses and satisfy this too.
 */
export type AirportInUniverse = Pick<RyanairActiveAirport, 'iataCode' | 'timeZone'> &
	Partial<Pick<RyanairActiveAirport, 'routes' | 'seasonalRoutes'>>;

export function readAirportFixture(fixture: string): AirportInUniverse[] {
	return JSON.parse(readFileSync(path.join(fixturesDir, fixture), 'utf-8'));
}

/**
 * The all-carrier graph, read both ways.
 *
 * `direct-routes.generated.json` is symmetric by contract. scripts/fetch-direct-routes.mjs
 * writes every edge under both endpoints, because an edge appears on only one of the two
 * Wikipedia articles far more often than on both. A fixture that broke that symmetry would be
 * answering a shape the app has never seen.
 *
 * It mirrors the airport list rather than being emptied. Emptying it would silence the
 * `bundled-direct-routes` source #361 added, and a suite that cannot exercise a source cannot
 * notice it breaking. Mirroring keeps the source live and makes what it says something a
 * reader can look up in one place.
 */
function symmetricNeighbours(
	destinationsByOrigin: Record<string, string[]>
): Record<string, string[]> {
	const neighbours = new Map<string, Set<string>>();
	const add = (from: string, to: string) => {
		const existing = neighbours.get(from) ?? new Set<string>();
		existing.add(to);
		neighbours.set(from, existing);
	};
	for (const [from, destinations] of Object.entries(destinationsByOrigin)) {
		for (const to of destinations) {
			add(from, to);
			add(to, from);
		}
	}
	return Object.fromEntries([...neighbours].map(([code, set]) => [code, [...set].sort()]));
}

function modulesFor(airports: readonly AirportInUniverse[]): Record<string, string> {
	// The app's own projection, so the graph the search ranks on is built by the code that
	// builds the real one. The cast covers the fields it never reads.
	const snapshot = buildNetworkSnapshot(airports as RyanairActiveAirportsResponse, FETCHED_AT);
	return {
		[SOURCES.ryanairNetwork]: JSON.stringify(snapshot),
		[SOURCES.directRoutes]: JSON.stringify({
			fetchedAt: FETCHED_AT,
			neighbours: symmetricNeighbours(snapshot.destinationsByOrigin)
		}),
		// Empty rather than derived: this dataset is cached *fares*, not a route graph, and a
		// spec's fares come from its own Ryanair and Kiwi mocks. A row here would be a second,
		// silent source of prices.
		[SOURCES.cheapRoutes]: JSON.stringify({ fetchedAt: FETCHED_AT, routes: [] })
	};
}

/**
 * Answers the three bundled route datasets from `airports`.
 *
 * Registered per chunk pathname rather than as one wide route, so anything else the app asks
 * its own origin for still reaches `network-guard.ts` untouched. Playwright gives the
 * most-recently-registered route first refusal, so calling this again with a different
 * airport list replaces the answer, which is how a spec re-pins the default the fixtures
 * install.
 */
export async function pinBundledRouteData(
	target: BrowserContext | Page,
	airports: readonly AirportInUniverse[] = readAirportFixture(DEFAULT_ACTIVE_AIRPORTS_FIXTURE)
) {
	const modules = modulesFor(airports);
	for (const [pathname, source] of chunkPathnames(Object.values(SOURCES))) {
		const body = `export default ${modules[source]};`;
		await target.route(`**${pathname}`, async (route) => {
			await route.fulfill({ status: 200, contentType: 'text/javascript', body });
		});
	}
}
