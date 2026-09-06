/**
 * Prints the ranked stopover candidates `algorithm/connections.ts` produces for a route,
 * with every score component, so a change to the weights can be compared instead of
 * argued about.
 *
 * Bundled sources only: the shipped Ryanair snapshot, the Wikipedia direct-route graph,
 * the build-time cheap-routes dataset and the hand fallback table. No network, so two
 * runs a week apart print the same numbers and a diff between them is the code.
 *
 *   node tools/probe-candidate-ranking.mjs BVC:PFO BCN:SOF
 *
 * The candidate list is the whole one, not the six that survive `maxCandidates` — the
 * ones past the cap are where a ranking change shows first.
 */

import { createServer } from 'vite';

const ROUTES = (process.argv.slice(2).length ? process.argv.slice(2) : ['BVC:PFO', 'BCN:SOF']).map(
	(pair) => {
		const [origin, destination] = pair.toUpperCase().split(':');
		if (!origin || !destination) throw new Error(`Expected ORIGIN:DESTINATION, got "${pair}"`);
		return { origin, destination };
	}
);

const server = await createServer({
	configFile: 'vite.config.ts',
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'error'
});

try {
	const { findConnectionCandidates } = await server.ssrLoadModule('/src/lib/algorithm/connections.ts');
	const { createCheapRoutesFlightProvider } = await server.ssrLoadModule(
		'/src/lib/search/providers-adapter.ts'
	);

	for (const { origin, destination } of ROUTES) {
		let beyondCap = [];
		const kept = await findConnectionCandidates(
			{ originAirport: origin, destinationAirport: destination },
			{
				flightProviders: [createCheapRoutesFlightProvider()],
				onCandidatesBeyondCap: (dropped) => {
					beyondCap = dropped;
				}
			}
		);
		const all = [...kept, ...beyondCap];

		console.log(`\n${origin} -> ${destination}: ${all.length} candidates confirmed on both legs`);
		if (all.length === 0) {
			console.log('  (no bundled source has an edge for this pair)');
			continue;
		}
		console.log('  #   code  score     connectivity  sizeClass  detour   balance   kept');
		all.forEach((candidate, index) => {
			const b = candidate.breakdown;
			console.log(
				[
					String(index + 1).padStart(3),
					candidate.airportCode.padEnd(4),
					candidate.score.toFixed(4).padStart(8),
					fmt(b.connectivity).padStart(12),
					fmt(b.sizeClass).padStart(9),
					fmt(b.detour).padStart(8),
					fmt(b.balance).padStart(8),
					index < kept.length ? '  yes' : '  no'
				].join('  ')
			);
		});

		const connectivity = all.map((candidate) => candidate.breakdown.connectivity);
		if (connectivity.every((value) => value === undefined)) {
			console.log('  connectivity: not a component of the score any more');
			continue;
		}
		const distinct = [...new Set(connectivity)].sort((a, b) => a - b);
		console.log(
			`  connectivity: ${distinct.length} distinct value(s) ` +
				`[${distinct.map((value) => fmt(value)).join(', ')}], spread ${fmt(
					Math.max(...connectivity) - Math.min(...connectivity)
				)}`
		);
	}
} finally {
	await server.close();
}

function fmt(value) {
	if (value === undefined) return '-';
	return value === null ? 'null' : value.toFixed(3);
}
