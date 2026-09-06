/**
 * What a search would ask a keyless provider, and where each candidate it keeps came from,
 * against the datasets that ship with the app. Issue #380.
 *
 *   node tools/probe-candidate-sources.mjs BVC:PFO BCN:TLL
 *
 * The provider handed to `findConnectionCandidates` is a recorder that answers "I do not
 * know" to everything and costs nothing, so its call log is exactly the set of route
 * questions a cold search would put to Kiwi. That number is what
 * `tests/qa/route-graph-fanout.qa.ts` bounds, so a change to candidate proposal can be
 * compared here before the suite is run, and against another branch by running this on
 * both.
 *
 * No network and no key, on purpose: two runs a week apart print the same numbers and a
 * diff between them is the code.
 */

import { createServer } from 'vite';

const ROUTES = (process.argv.slice(2).length ? process.argv.slice(2) : ['BVC:PFO', 'BCN:TLL']).map(
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
	const { findConnectionCandidates } = await server.ssrLoadModule(
		'/src/lib/algorithm/connections.ts'
	);

	for (const { origin, destination } of ROUTES) {
		const asked = [];
		const provider = recordingProvider(asked);
		let beyondCap = [];
		const kept = await findConnectionCandidates(
			{
				originAirport: origin,
				destinationAirport: destination,
				soonestDeparture: '2026-10-06'
			},
			{
				flightProviders: [provider],
				onCandidatesBeyondCap: (dropped) => {
					beyondCap = dropped;
				}
			}
		);
		const all = [...kept, ...beyondCap];

		console.log(`\n=== ${origin} -> ${destination} ===`);
		console.log(`route questions asked: ${asked.length}`);
		for (const pair of [...asked].sort()) console.log(`  ${pair}`);
		console.log(`confirmed on both legs: ${all.length}, kept ${kept.length}`);
		console.log('  #   code  score     outbound                 inbound                  metered');
		all.forEach((candidate, index) => {
			console.log(
				[
					String(index + 1).padStart(3),
					candidate.airportCode.padEnd(4),
					candidate.score.toFixed(4).padStart(8),
					candidate.confirmedBy.outbound.padEnd(24),
					candidate.confirmedBy.inbound.padEnd(24),
					String(candidate.meteredRequestSpent)
				].join('  ')
			);
		});
	}
} finally {
	await server.close();
}

/**
 * A free `FlightProvider` that knows nothing and records every question.
 *
 * `estimateSearchOffersCost` returning 0 is what `isFreeProvider` reads to classify it, so
 * this stands exactly where `kiwi-public` stands in a real search. Answering "I do not
 * know" rather than a route keeps the candidate set purely a function of bundled data,
 * which is what makes two runs comparable.
 */
function recordingProvider(asked) {
	const source = () => ({ providerId: 'kiwi-public', fetchedAt: new Date().toISOString() });
	return {
		kind: 'flight',
		id: 'kiwi-public',
		label: 'Recording stub',
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: { message: 'reachable' }, source: source(), requestsUsed: 0 };
		},
		estimateSearchOffersCost() {
			return 0;
		},
		async searchOffers() {
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		},
		async listDirectDestinations(iataCode) {
			asked.push(`${iataCode}->*`);
			return { ok: true, data: [], source: source(), requestsUsed: 1 };
		},
		async hasDirectRoute(from, to) {
			asked.push(`${from}->${to}`);
			return { ok: true, data: false, source: source(), requestsUsed: 1 };
		}
	};
}
