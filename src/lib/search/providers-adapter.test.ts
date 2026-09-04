import { describe, expect, it, vi } from 'vitest';
import type { CheapRoute } from '../data/cheap-routes';

/** The instant the stubbed dataset says it was fetched. Deliberately long past, so a
 * `new Date()` creeping back into `source()` (issue #169) fails loudly instead of
 * looking plausible. */
const DATASET_FETCHED_AT = '2026-08-01T03:17:22.481Z';

const getCheapRoutesFrom = vi.fn<(origin: string) => Promise<CheapRoute[]>>();
// The literal is repeated inside the factory rather than referencing the constant above:
// `vi.mock` is hoisted above every `const` in this file, so naming DATASET_FETCHED_AT in
// there is a temporal-dead-zone error at run time, not a tidier version of the same thing.
vi.mock('../data/cheap-routes', () => ({
	getCheapRoutesFrom: (origin: string) => getCheapRoutesFrom(origin),
	loadCheapRoutesDataset: async () => ({ fetchedAt: '2026-08-01T03:17:22.481Z', routes: [] })
}));

// Imported after the mock is registered, per vitest's hoisting contract for vi.mock.
const { CHEAP_ROUTES_PROVIDER_ID, createCheapRoutesFlightProvider } = await import('./providers-adapter');

function fakeCheapRoute(origin: string, destination: string): CheapRoute {
	return {
		origin,
		destination,
		airline: 'FR',
		flightNumber: null,
		price: { minorUnits: 4000, currency: 'EUR' },
		departureAt: '2026-10-01T08:00:00',
		returnAt: null,
		transfers: 0,
		expiresAt: '2026-10-05T00:00:00Z'
	};
}

const CTX = { signal: new AbortController().signal };

describe('createCheapRoutesFlightProvider', () => {
	it('is keyless, free, and identifies itself by the cheap-routes provider id', () => {
		const provider = createCheapRoutesFlightProvider();
		expect(provider.id).toBe(CHEAP_ROUTES_PROVIDER_ID);
		expect(provider.needsKey).toBe(false);
		expect(provider.estimateSearchOffersCost({ origin: 'ZOR', destination: 'ZFA', earliestDeparture: '2026-10-01', latestDeparture: '2026-10-10' })).toBe(0);
	});

	it('maps cheap routes to destination codes via listDirectDestinations', async () => {
		getCheapRoutesFrom.mockResolvedValueOnce([fakeCheapRoute('ZOR', 'ZFA'), fakeCheapRoute('ZOR', 'ZSL')]);

		const provider = createCheapRoutesFlightProvider();
		const result = await provider.listDirectDestinations('ZOR', CTX);

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.sort()).toEqual(['ZFA', 'ZSL']);
		expect(result.requestsUsed).toBe(0); // build-time data, never a real network request
	});

	it('reports no destinations, never throws, for an origin the dataset has nothing for', async () => {
		getCheapRoutesFrom.mockResolvedValueOnce([]);
		const result = await createCheapRoutesFlightProvider().listDirectDestinations('XXX', CTX);
		expect(result).toEqual({ ok: true, data: [], source: expect.any(Object), requestsUsed: 0 });
	});

	it('never produces a real flight offer — searchOffers always resolves empty', async () => {
		const provider = createCheapRoutesFlightProvider();
		const result = await provider.searchOffers(
			{ origin: 'ZOR', destination: 'ZFA', earliestDeparture: '2026-10-01', latestDeparture: '2026-10-01' },
			CTX
		);
		expect(result).toEqual({ ok: true, data: [], source: expect.any(Object), requestsUsed: 0 });
	});

	// Issue #169. Every answer this adapter gives used to be stamped
	// `fetchedAt: new Date().toISOString()`, so a dataset compiled into the bundle weeks
	// earlier reported itself as seconds old. The instant belongs to the build that
	// fetched the data, and it is now written into the dataset for this to read back.
	describe('provenance', () => {
		it('reports the dataset’s own fetch instant, not the clock at call time', async () => {
			getCheapRoutesFrom.mockResolvedValueOnce([fakeCheapRoute('ZOR', 'ZFA')]);
			const provider = createCheapRoutesFlightProvider();

			const listed = await provider.listDirectDestinations('ZOR', CTX);
			const searched = await provider.searchOffers(
				{ origin: 'ZOR', destination: 'ZFA', earliestDeparture: '2026-10-01', latestDeparture: '2026-10-01' },
				CTX
			);
			const health = await provider.healthCheck(CTX);

			for (const result of [listed, searched, health]) {
				expect(result.source).toEqual({
					providerId: CHEAP_ROUTES_PROVIDER_ID,
					fetchedAt: DATASET_FETCHED_AT
				});
			}
		});

		it('does not drift towards now between two calls', async () => {
			// The tell of a `new Date()` stamp: two calls a moment apart disagree. A build
			// artefact's fetch instant is the same fact however often it is asked for.
			getCheapRoutesFrom.mockResolvedValue([]);
			const provider = createCheapRoutesFlightProvider();

			const first = await provider.listDirectDestinations('ZOR', CTX);
			await new Promise((resolve) => setTimeout(resolve, 5));
			const second = await provider.listDirectDestinations('ZOR', CTX);

			expect(first.source.fetchedAt).toBe(second.source.fetchedAt);
			expect(Date.parse(first.source.fetchedAt)).toBeLessThan(Date.now());
		});
	});
});
