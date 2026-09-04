import { describe, expect, it, vi } from 'vitest';
import { runCostAwareSearch } from '../providers/budget';
import { ProviderRegistry } from '../providers/registry';
import type { AnyProvider, AvailableKeys, FlightProvider, FlightSearchQuery, ProviderContext, ProviderResult } from '../providers/types';
import type { FlightOffer } from '../domain';
import {
	flattenOk,
	flightCostAwareSources,
	meteredRequestsUsed,
	pickMeteredWithinBudget
} from './cost-aware';
import { recordProviderResult, SourceTracker } from './provenance';
import type { ProviderStatus } from './types';

function fakeOffer(carrierCode: string): FlightOffer {
	return {
		carrier: { iataCode: carrierCode, name: 'Fake Air' },
		flightNumber: `${carrierCode}1`,
		departureAirport: 'ZOR',
		arrivalAirport: 'ZDE',
		departure: { local: '2026-10-01T08:00:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
		arrival: { local: '2026-10-01T10:00:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
		duration: 120 as never,
		price: { minorUnits: 1000, currency: 'EUR' },
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test'
	};
}

function fakeProvider(id: string, cost: number, needsKey = false): FlightProvider {
	return {
		kind: 'flight',
		id,
		label: `Fake (${id})`,
		needsKey,
		keyFields: needsKey ? [{ id: 'apiKey', label: 'Key' }] : [],
		async healthCheck() {
			return { ok: true, data: {}, source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' }, requestsUsed: 0 };
		},
		estimateSearchOffersCost: () => cost,
		async searchOffers(_query: FlightSearchQuery, ctx: ProviderContext): Promise<ProviderResult<FlightOffer[]>> {
			return {
				ok: true,
				data: [fakeOffer(id.toUpperCase())],
				source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' },
				requestsUsed: ctx.maxRequests !== undefined ? Math.min(cost, ctx.maxRequests) : cost
			};
		},
		async listDirectDestinations() {
			return { ok: true, data: [], source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' }, requestsUsed: 0 };
		}
	};
}

const QUERY: FlightSearchQuery = {
	origin: 'ZOR',
	destination: 'ZDE',
	earliestDeparture: '2026-10-01',
	latestDeparture: '2026-10-01'
};

function newTracking() {
	const providerStatus = new Map<string, ProviderStatus>();
	const record = (provider: Pick<AnyProvider, 'id' | 'kind' | 'label'>, result: ProviderResult<unknown>) =>
		recordProviderResult(providerStatus, provider, result);
	return { providerStatus, record, sources: new SourceTracker() };
}

describe('flightCostAwareSources', () => {
	it('classifies a zero-cost provider as free and a positive-cost one as metered', () => {
		const { record, sources } = newTracking();
		const free = fakeProvider('ryanair', 0);
		const metered = fakeProvider('skyscanner', 1, true);
		const keys: AvailableKeys = { skyscanner: { apiKey: 'k' } };
		const controller = new AbortController();

		const built = flightCostAwareSources([free, metered], QUERY, keys, controller.signal, sources, record);
		const byId = Object.fromEntries(built.map((s) => [s.providerId, s]));

		expect(byId.ryanair.tier).toBe('free');
		expect(byId.skyscanner.tier).toBe('metered');
		expect(byId.skyscanner.estimatedCost).toBe(1);
	});

	it('excludes an unusable provider entirely', () => {
		const { record, sources } = newTracking();
		const metered = fakeProvider('skyscanner', 1, true);
		const controller = new AbortController();

		const built = flightCostAwareSources([metered], QUERY, {}, controller.signal, sources, record);
		expect(built).toHaveLength(0);
	});

	it('running a free-tier source with runCostAwareSearch never calls a metered one', async () => {
		const { record, sources, providerStatus } = newTracking();
		const free = fakeProvider('ryanair', 0);
		const metered = fakeProvider('skyscanner', 2, true);
		const meteredSpy = vi.spyOn(metered, 'searchOffers');
		const keys: AvailableKeys = { skyscanner: { apiKey: 'k' } };
		const controller = new AbortController();

		const sourcesList = flightCostAwareSources([free, metered], QUERY, keys, controller.signal, sources, record);
		const result = await runCostAwareSearch(sourcesList); // no widenTo

		expect(meteredSpy).not.toHaveBeenCalled();
		expect(flattenOk(result)).toHaveLength(1);
		expect(flattenOk(result)[0].carrier.iataCode).toBe('RYANAIR');
		expect(providerStatus.get('ryanair')?.requestsUsed).toBeGreaterThan(-1);
	});

	it('running with widenTo spends the named metered source and tags provenance', async () => {
		const { record, sources } = newTracking();
		const metered = fakeProvider('skyscanner', 1, true);
		const keys: AvailableKeys = { skyscanner: { apiKey: 'k' } };
		const controller = new AbortController();

		const sourcesList = flightCostAwareSources([metered], QUERY, keys, controller.signal, sources, record);
		const result = await runCostAwareSearch(sourcesList, { widenTo: ['skyscanner'] });
		const offers = flattenOk(result);

		expect(offers).toHaveLength(1);
		expect(sources.sourceFor(offers[0])?.providerId).toBe('skyscanner');
		expect(meteredRequestsUsed(result)).toBe(1);
	});
});

describe('pickMeteredWithinBudget', () => {
	it('picks cheapest-first sources that fit the remaining budget', () => {
		const { record, sources } = newTracking();
		const cheap = fakeProvider('cheap-metered', 2, true);
		const pricey = fakeProvider('pricey-metered', 5, true);
		const keys: AvailableKeys = { 'cheap-metered': { apiKey: 'k' }, 'pricey-metered': { apiKey: 'k' } };
		const controller = new AbortController();

		const built = flightCostAwareSources([pricey, cheap], QUERY, keys, controller.signal, sources, record);
		expect(pickMeteredWithinBudget(built, 3)).toEqual(['cheap-metered']);
		expect(pickMeteredWithinBudget(built, 7)).toEqual(['cheap-metered', 'pricey-metered']);
		expect(pickMeteredWithinBudget(built, 0)).toEqual([]);
	});
});

describe('registry integration sanity', () => {
	it('ofKind/usable still work with cost-aware sources built from a real registry', () => {
		const registry = new ProviderRegistry([fakeProvider('ryanair', 0), fakeProvider('skyscanner', 1, true)]);
		expect(registry.ofKind('flight')).toHaveLength(2);
		expect(registry.usable('flight', {}).map((p) => p.id)).toEqual(['ryanair']);
	});
});
