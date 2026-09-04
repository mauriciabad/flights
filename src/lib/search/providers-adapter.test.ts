import { describe, expect, it, vi } from 'vitest';
import type { CheapRoute } from '../data/cheap-routes';

const getCheapRoutesFrom = vi.fn<(origin: string) => Promise<CheapRoute[]>>();
vi.mock('../data/cheap-routes', () => ({ getCheapRoutesFrom: (origin: string) => getCheapRoutesFrom(origin) }));

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
});
