import { describe, expect, it, vi } from 'vitest';
import { runCostAwareSearch } from '../providers/budget';
import { ProviderRegistry } from '../providers/registry';
import type {
	AnyProvider,
	AvailableKeys,
	FlightProvider,
	FlightSearchQuery,
	ProviderContext,
	ProviderId,
	ProviderResult,
	StayProvider,
	StaySearchQuery
} from '../providers/types';
import type { FlightOffer, Stay } from '../domain';
import {
	autoWidenStaySources,
	flattenOk,
	flightCostAwareSources,
	meteredRequestsUsed,
	pickMeteredWithinBudget,
	stayCostAwareSources
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
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test'
	};
}

function fakeProvider(idString: string, cost: number, needsKey = false): FlightProvider {
	// Fixture-only stand-in id, not a real registered adapter — cast rather than widening
	// FlightProvider.id itself, which is exactly the closed `ProviderId` union issue #69
	// exists to enforce for real adapters.
	const id = idString as ProviderId;
	return {
		kind: 'flight',
		id,
		label: `Fake (${idString})`,
		needsKey,
		keyFields: needsKey ? [{ id: 'apiKey', label: 'Key' }] : [],
		async healthCheck() {
			return { ok: true, data: {}, source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' }, requestsUsed: 0 };
		},
		estimateSearchOffersCost: () => cost,
		async searchOffers(_query: FlightSearchQuery, ctx: ProviderContext): Promise<ProviderResult<FlightOffer[]>> {
			return {
				ok: true,
				data: [fakeOffer(idString.toUpperCase())],
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

/** A stay-provider fixture with a REAL `ProviderId` — 'agoda', 'booking' or 'skyscanner'
 * are cast here only to satisfy `StayProvider.kind`, not because those ids are really
 * stay adapters; what matters for issue #94's tests is that `../providers/budget/caps.ts`'s
 * `DEFAULT_PROVIDER_CAPS` has a tuned, non-fallback entry for each. */
function fakeStayProvider(id: ProviderId, cost: number, needsKey = true): StayProvider {
	const stay: Stay = {
		property: { name: `${id} stay`, coordinates: { latitude: 48.2, longitude: 16.37 }, images: [] },
		roomKind: 'dorm',
		pricePerNight: { minorUnits: 2000, currency: 'EUR' }
	};
	return {
		kind: 'stay',
		id,
		label: `Fake stays (${id})`,
		needsKey,
		keyFields: needsKey ? [{ id: 'apiKey', label: 'Key' }] : [],
		async healthCheck() {
			return { ok: true, data: {}, source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' }, requestsUsed: 0 };
		},
		estimateSearchStaysCost: () => cost,
		async searchStays(_query: StaySearchQuery, ctx: ProviderContext): Promise<ProviderResult<Stay[]>> {
			return {
				ok: true,
				data: [stay],
				source: { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' },
				requestsUsed: ctx.maxRequests !== undefined ? Math.min(cost, ctx.maxRequests) : cost
			};
		}
	};
}

const STAY_QUERY: StaySearchQuery = {
	near: { latitude: 48.2, longitude: 16.37 },
	radiusKm: 100,
	checkIn: '2026-10-01',
	checkOut: '2026-10-03'
};

function newTracking() {
	const providerStatus = new Map<ProviderId, ProviderStatus>();
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

describe('autoWidenStaySources (issue #94)', () => {
	it('auto-widens a keyed, quota-generous metered stay provider (Agoda-shaped)', async () => {
		const { record, sources } = newTracking();
		// Real Agoda cost: 1 search + up to 5 get-prices drill-downs.
		const agoda = fakeStayProvider('agoda', 6);
		const keys: AvailableKeys = { agoda: { apiKey: 'k' } };
		const controller = new AbortController();

		const built = stayCostAwareSources([agoda], STAY_QUERY, keys, controller.signal, sources, record);
		expect(built[0]?.tier).toBe('metered'); // still costs something — never reclassified as free
		expect(autoWidenStaySources(built)).toEqual(['agoda']);

		const result = await runCostAwareSearch(built, { widenTo: autoWidenStaySources(built) });
		expect(flattenOk(result)).toHaveLength(1);
		expect(result.report.ranMetered).toEqual(['agoda']);
	});

	it('auto-widens a keyed, quota-generous metered stay provider (Booking-shaped, exactly at the threshold)', () => {
		const { record, sources } = newTracking();
		// Real Booking cost: 1 search + 1 getRoomList drill-down.
		const booking = fakeStayProvider('booking', 2);
		const keys: AvailableKeys = { booking: { apiKey: 'k' } };
		const controller = new AbortController();

		const built = stayCostAwareSources([booking], STAY_QUERY, keys, controller.signal, sources, record);
		expect(autoWidenStaySources(built)).toEqual(['booking']);
	});

	it('does not auto-widen a stay provider with no key configured at all', () => {
		const { record, sources } = newTracking();
		const agoda = fakeStayProvider('agoda', 6);
		const controller = new AbortController();

		// No key in `keys` — `stayCostAwareSources` filters unusable providers out before
		// this function ever sees them, same as it already does for flights.
		const built = stayCostAwareSources([agoda], STAY_QUERY, {}, controller.signal, sources, record);
		expect(built).toHaveLength(0);
		expect(autoWidenStaySources(built)).toEqual([]);
	});

	it('leaves a Sky-Scrapper-tight metered stay provider out, still requiring explicit consent', () => {
		const { record, sources } = newTracking();
		// 'skyscanner' cast here purely to reuse its real tuned cap (15) from the budget
		// module's table — a hypothetical stay provider this scarce should be treated the
		// same way the real Sky Scrapper flight provider is.
		const tight = fakeStayProvider('skyscanner', 1);
		const keys: AvailableKeys = { skyscanner: { apiKey: 'k' } };
		const controller = new AbortController();

		const built = stayCostAwareSources([tight], STAY_QUERY, keys, controller.signal, sources, record);
		expect(autoWidenStaySources(built)).toEqual([]);
	});

	it('never lists a free stay source — nothing to widen to', () => {
		const { record, sources } = newTracking();
		const free = fakeStayProvider('ryanair', 0, false);
		const controller = new AbortController();

		const built = stayCostAwareSources([free], STAY_QUERY, {}, controller.signal, sources, record);
		expect(built[0]?.tier).toBe('free');
		expect(autoWidenStaySources(built)).toEqual([]);
	});
});
