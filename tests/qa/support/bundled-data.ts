/**
 * The datasets the app ships inside its own bundle, rewritten to say what
 * `./scenario.ts` says.
 *
 * Issue #379. Everything a provider sends this suite goes through `bench.ts`'s recording,
 * but three of the sources `algorithm/connections.ts` ranks candidates from are not
 * providers at all: they are JSON files the app reaches with a plain dynamic `import()`.
 * The bench let those through as ordinary app assets, so the `BCN -> TLL` scenario was
 * ranked against Ryanair's real 224-airport snapshot and a 98 KB Wikipedia route graph
 * while its fixture described seven airports. BER, STN, DUB and MXP all reach Tallinn in
 * shipped data the bench never answered for.
 *
 * That is not a cosmetic gap. `route-graph-fanout.qa.ts` claimed the bench's candidate set
 * was "shorter than the ceiling" it measures, which was false, and in `tests/e2e/` the same
 * hole broke three specs the moment #361 widened the graph — their fixtures had stopped
 * describing their own scenarios and nobody could see it until the data moved.
 *
 * ## Why the chunk is intercepted rather than aliased at build time
 *
 * A Vite alias behind a QA environment variable would work and was rejected: `qa.config.ts`
 * runs this suite against the real production build on purpose, and a build with different
 * data in it is a build nobody ships. Answering the chunk over the wire leaves the bundle
 * exactly as GitHub Pages will serve it, and it is the same move `bench.ts` already makes
 * for images.
 *
 * ## Finding the chunk
 *
 * SvelteKit names every chunk by content hash alone — `app/immutable/chunks/CSe2j8Wu.js`,
 * with nothing of the source path left in it — so no URL pattern can match one. Vite's own
 * build manifest maps source module to emitted file, which is exactly the question, so this
 * reads that instead of guessing.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIRPORT_TIME_ZONES, ROUTE_GRAPH } from './scenario';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const MANIFEST = path.join(repoRoot, '.svelte-kit', 'output', 'client', '.vite', 'manifest.json');

/** Plainly in the past, so where the app compares a bundled snapshot against one it just
 * fetched (`newerSnapshot` in ryanair-network.ts) the recorded answer wins, which is what
 * happens in production too. */
const FETCHED_AT = '2026-09-01T00:00:00.000Z';

/**
 * `ROUTE_GRAPH` read both ways.
 *
 * `direct-routes.generated.json` is symmetric by contract — scripts/fetch-direct-routes.mjs
 * writes every edge under both endpoints, because an edge appears on only one of the two
 * Wikipedia articles far more often than on both. A fixture that broke that would be
 * answering a shape the app has never seen.
 */
function symmetricRouteGraph(): Record<string, string[]> {
	const neighbours = new Map<string, Set<string>>();
	const add = (from: string, to: string) => {
		const existing = neighbours.get(from) ?? new Set<string>();
		existing.add(to);
		neighbours.set(from, existing);
	};
	for (const [from, destinations] of Object.entries(ROUTE_GRAPH)) {
		for (const to of destinations) {
			add(from, to);
			add(to, from);
		}
	}
	return Object.fromEntries([...neighbours].map(([code, set]) => [code, [...set].sort()]));
}

/**
 * Every bundled dataset that can propose or confirm a route, and what the scenario says
 * instead.
 *
 * `airports.generated.json` and `city-centres.generated.json` are deliberately absent. They
 * carry geography — coordinates, size class, country — which is what `scoreGeography` ranks
 * on, and the scenario names real airports precisely so that ranking is real. Replacing
 * those would not pin the universe, it would delete it.
 */
const FIXTURES: Record<string, () => unknown> = {
	'src/lib/data/ryanair-network.generated.json': () => ({
		fetchedAt: FETCHED_AT,
		destinationsByOrigin: ROUTE_GRAPH,
		timeZonesByIataCode: AIRPORT_TIME_ZONES
	}),
	'src/lib/data/direct-routes.generated.json': () => ({
		fetchedAt: FETCHED_AT,
		neighbours: symmetricRouteGraph()
	}),
	// Empty rather than derived: this dataset is cached *fares*, not a route graph, and the
	// scenario's fares come from the recorded Ryanair and Kiwi answers. A row here would be
	// a second, silent source of prices for the checks that count what a search costs.
	'src/lib/data/cheap-routes.generated.json': () => ({ fetchedAt: FETCHED_AT, routes: [] })
};

let byPathname: Map<string, string> | null = null;

/**
 * The replacement module for a built chunk, or `undefined` for any other app asset.
 *
 * Throws rather than falling back when the manifest is missing or has stopped naming one of
 * these datasets. Falling back would mean quietly reading the real 224-airport graph again,
 * which is the whole defect, and it would look like a passing suite.
 */
export function bundledDataModuleFor(pathname: string): string | undefined {
	byPathname ??= buildIndex();
	return byPathname.get(pathname);
}

function buildIndex(): Map<string, string> {
	let manifest: Record<string, { file?: string }>;
	try {
		manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
	} catch (cause) {
		throw new Error(
			`Could not read Vite's build manifest at ${MANIFEST}. ` +
				'The QA bench needs it to find which hashed chunk serves each bundled dataset. ' +
				'Run `pnpm build` first, or update this path if the build output moved.',
			{ cause }
		);
	}

	const index = new Map<string, string>();
	for (const [source, body] of Object.entries(FIXTURES)) {
		const file = manifest[source]?.file;
		if (!file) {
			throw new Error(
				`Vite's build manifest does not name a chunk for ${source}. ` +
					'Either the module stopped being a dynamic import — in which case its data is now ' +
					'inside a shared chunk and this bench can no longer answer for it — or the file ' +
					'was renamed. Either way the QA scenario is silently ranking against real shipped ' +
					'data again, which is issue #379.'
			);
		}
		index.set(`/${file}`, `export default ${JSON.stringify(body())};`);
	}
	return index;
}
