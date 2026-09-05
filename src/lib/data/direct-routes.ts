/**
 * Issue #361: an all-carrier direct-route graph as one shipped snapshot, built at build
 * time from English Wikipedia's `{{Airport-dest-list}}` tables
 * (scripts/fetch-direct-routes.mjs, .github/workflows/direct-routes.yml) and lazy-loaded
 * from the generated JSON here, the same shape ryanair-network.ts wears for a different
 * source.
 *
 * Ryanair's snapshot is one airline's whole network. This is many airlines' partial one,
 * and the two answer different questions. Before this file existed every stopover
 * candidate came from the origin's own direct-destination list, which for Boa Vista is
 * Kiwi's price-sorted, aggregator-capped sample of 20 rows. East Midlands is not in that
 * sample and is nobody's metro sibling, so no search could propose it, while both of its
 * legs are on sale. The graph is where such a candidate now comes from.
 *
 * A floor, never a ceiling, and by a wider margin than Ryanair's is. It is hand-edited
 * text: it lags a schedule change, it names 98.6% of the edges in Ryanair's own bundled
 * snapshot rather than all of them, and its node set is bounded by the codes the other
 * bundled sources already name. So `hasDirectRoute` returning `false` means "this table
 * does not say so", never "no such route", and nothing here may silence another source.
 *
 * The generated file is CC BY-SA 4.0, unlike the rest of this repo. See
 * src/lib/data/direct-routes.LICENSE.md.
 */

import type { IataAirportCode } from '$lib/domain';

/**
 * Who flies where, according to Wikipedia's airport articles as of `fetchedAt`.
 */
export interface DirectRouteGraph {
	/** ISO instant the Wikipedia revisions were read. */
	fetchedAt: string;
	/**
	 * IATA code to every code it has a scheduled direct flight to or from.
	 *
	 * Symmetric: an entry under A naming B always has one under B naming A, written both
	 * ways by scripts/fetch-direct-routes.mjs, so no loader has to remember to mirror it.
	 * That is not a tidiness choice. An edge appears on only one of the two articles far
	 * more often than on both, and this issue's own route is an example: Boa Vista's page
	 * names East Midlands, and it is East Midlands' page that names Paphos.
	 *
	 * An airport ABSENT from this map is not an answer, unlike in `RyanairNetworkSnapshot`.
	 * It means no article in the seed set named it, which is a gap in a hand-edited source
	 * rather than a statement that it flies nowhere.
	 */
	neighbours: Record<string, IataAirportCode[]>;
}

let bundledGraphPromise: Promise<DirectRouteGraph> | null = null;
let neighbourSets: WeakMap<DirectRouteGraph, Map<string, Set<string>>> = new WeakMap();

/**
 * Loads the shipped graph on first call and memoizes it for the lifetime of the page. A
 * dynamic `import()` of a JSON file is its own chunk under Vite/Rollup, so the 98 KB (15 KB
 * over the wire) only downloads once something actually searches, exactly like
 * `loadBundledRyanairNetwork` and `loadAirports`.
 */
export function loadBundledDirectRoutes(): Promise<DirectRouteGraph> {
	bundledGraphPromise ??= import('./direct-routes.generated.json').then(
		(mod) => mod.default as DirectRouteGraph
	);
	return bundledGraphPromise;
}

/**
 * Every airport with a known direct route to or from `code`, or `[]` when no article in
 * the seed set named it. Never a throw and never `undefined`, matching
 * `directDestinationsFrom`'s convention in ryanair-network.ts and `getAirport`'s in
 * airports.ts.
 */
export function neighboursOf(
	graph: DirectRouteGraph,
	code: IataAirportCode
): IataAirportCode[] {
	const normalised = code?.trim().toUpperCase();
	if (!normalised) return [];
	return graph.neighbours[normalised] ?? [];
}

/**
 * Whether the graph records a direct route between `a` and `b`.
 *
 * `false` means "this table does not say so", never "no such route" -- see the module
 * comment. `connections.ts` relies on that reading and falls through to the next source.
 *
 * Backed by a `Set` per airport rather than by `Array.includes`, because the caller asks
 * this once per candidate inside a loop over a hub's whole out-degree, and Stansted's
 * neighbour list is 179 long. Built on first use and cached against the graph object, so a
 * search that never asks this question never pays for it.
 */
export function hasDirectRoute(
	graph: DirectRouteGraph,
	a: IataAirportCode,
	b: IataAirportCode
): boolean {
	const from = a?.trim().toUpperCase();
	const to = b?.trim().toUpperCase();
	if (!from || !to) return false;

	let sets = neighbourSets.get(graph);
	if (!sets) {
		sets = new Map(
			Object.entries(graph.neighbours).map(([code, codes]) => [code, new Set<string>(codes)])
		);
		neighbourSets.set(graph, sets);
	}
	return sets.get(from)?.has(to) ?? false;
}
