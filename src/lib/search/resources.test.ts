/**
 * Issue #80: `fetchConnectionResources` (and `fetchCheapestStay` underneath it) must never
 * hand a `female-dorm` to a party that cannot fully use one, no matter how much cheaper it
 * is than every other option, and must keep every `Stay` it found — not just the one it
 * picked — so a caller can offer real alternatives (issue #27's stay picker).
 */

import { describe, expect, it } from 'vitest';
import type { Stay } from '../domain';
import type {
	AvailableKeys,
	ProviderContext,
	ProviderId,
	ProviderResult,
	StayProvider,
	StaySearchQuery,
	TransferProvider,
	TransferSearchQuery
} from '../providers/types';
import { fetchConnectionResources } from './resources';
import { recordProviderResult, SourceTracker } from './provenance';
import type { ProviderStatus } from './types';

// Every id passed through here is a fixture-only stand-in, not a real registered adapter —
// cast rather than widening ProviderSource.providerId itself, which is exactly the closed
// `ProviderId` union issue #69 exists to enforce for real adapters.
function source(providerId: string) {
	return { providerId: providerId as ProviderId, fetchedAt: '2026-09-04T00:00:00Z' };
}

/** A stay provider that always returns the same fixed list of stays, regardless of query —
 * these tests only care about the pricing/room-kind mix, not about geography. */
function fakeStayProvider(idString: string, stays: Stay[]): StayProvider {
	const id = idString as ProviderId; // see source() above
	return {
		kind: 'stay',
		id,
		label: `Fixture stays (${idString})`,
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: {}, source: source(id), requestsUsed: 0 };
		},
		estimateSearchStaysCost: () => 0,
		async searchStays(_query: StaySearchQuery, ctx: ProviderContext): Promise<ProviderResult<Stay[]>> {
			if (ctx.signal.aborted) {
				return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: source(id), requestsUsed: 0 };
			}
			return { ok: true, data: stays, source: source(id), requestsUsed: 1 };
		}
	};
}

function fakeTransferProvider(): TransferProvider {
	return {
		kind: 'transfer',
		id: 'transit-fixture' as ProviderId, // fixture-only stand-in id, see source() above
		label: 'Fixture transfers',
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: {}, source: source('transit-fixture'), requestsUsed: 0 };
		},
		async searchTransfers(_query: TransferSearchQuery, ctx: ProviderContext): Promise<ProviderResult<import('../domain').Transfer[]>> {
			if (ctx.signal.aborted) {
				return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: source('transit-fixture'), requestsUsed: 0 };
			}
			return {
				ok: true,
				data: [{ mode: 'transit', duration: 20 as never, legs: [] }],
				source: source('transit-fixture'),
				requestsUsed: 1
			};
		}
	};
}

function stay(name: string, roomKind: Stay['roomKind'], minorUnits: number): Stay {
	return {
		property: { name, coordinates: { latitude: 48.2, longitude: 16.37 }, images: [] },
		roomKind,
		pricePerNight: { minorUnits, currency: 'EUR' }
	};
}

function newTracking() {
	const providerStatus = new Map<ProviderId, ProviderStatus>();
	const record = (provider: { id: string; kind: string; label: string }, result: ProviderResult<unknown>) =>
		recordProviderResult(providerStatus, provider as never, result);
	return { record, sources: new SourceTracker() };
}

const CONNECTION_COORDINATES = { latitude: 48.2082, longitude: 16.3738 };

function baseInput(
	stayProviders: readonly StayProvider[],
	extra: { travellers?: number; females?: number } = {}
) {
	const { record, sources } = newTracking();
	const keys: AvailableKeys = {};
	const controller = new AbortController();
	return {
		connectionCoordinates: CONNECTION_COORDINATES,
		connectionAirportSize: 'medium' as const,
		stayProviders,
		transferProviders: [fakeTransferProvider()],
		keys,
		signal: controller.signal,
		stayRadiusKm: 100,
		checkIn: '2026-10-01' as const,
		checkOut: '2026-10-03' as const,
		landingToTransportRules: [],
		sources,
		record,
		...extra
	};
}

describe('fetchConnectionResources: gender-fit filtering (issue #80)', () => {
	it('never selects a female-only dorm for a zero-female group, even when it is by far the cheapest', async () => {
		const stays = [stay('Cheap Female Dorm', 'female-dorm', 1000), stay('Pricier Mixed Dorm', 'dorm', 2200)];
		const input = baseInput([fakeStayProvider('stays', stays)], { travellers: 4, females: 0 });

		const resources = await fetchConnectionResources(input);

		expect(resources).toBeDefined();
		expect(resources!.stay.roomKind).not.toBe('female-dorm');
		expect(resources!.stay.property.name).toBe('Pricier Mixed Dorm');
	});

	it('returns no resources when the only stay found is a female-only dorm a zero-female group cannot use', async () => {
		const stays = [stay('Only Female Dorm', 'female-dorm', 1000)];
		const input = baseInput([fakeStayProvider('stays', stays)], { travellers: 2, females: 0 });

		const resources = await fetchConnectionResources(input);

		// Never falls back to pricing a bed nobody in the party can book — no stay reachable
		// is the same "no usable itinerary leg" outcome as no stay found at all.
		expect(resources).toBeUndefined();
	});

	it('still selects a female-only dorm for a mixed group when it is cheapest, if females is unspecified', async () => {
		const stays = [stay('Cheap Female Dorm', 'female-dorm', 1000), stay('Pricier Mixed Dorm', 'dorm', 2200)];
		// females omitted entirely — absent means "do not filter", not the same as 0
		// (domain/search-query.ts's own doc comment).
		const input = baseInput([fakeStayProvider('stays', stays)], { travellers: 4 });

		const resources = await fetchConnectionResources(input);

		expect(resources).toBeDefined();
		expect(resources!.stay.roomKind).toBe('female-dorm');
		expect(resources!.stay.property.name).toBe('Cheap Female Dorm');
	});

	it('selects a female-only dorm normally when the whole group is female', async () => {
		const stays = [stay('Cheap Female Dorm', 'female-dorm', 1000), stay('Pricier Mixed Dorm', 'dorm', 2200)];
		const input = baseInput([fakeStayProvider('stays', stays)], { travellers: 2, females: 2 });

		const resources = await fetchConnectionResources(input);

		expect(resources).toBeDefined();
		expect(resources!.stay.roomKind).toBe('female-dorm');
	});

	it('keeps every stay found in `stayCandidates`, ineligible ones included, not just the chosen one', async () => {
		const stays = [stay('Cheap Female Dorm', 'female-dorm', 1000), stay('Pricier Mixed Dorm', 'dorm', 2200)];
		const input = baseInput([fakeStayProvider('stays', stays)], { travellers: 4, females: 0 });

		const resources = await fetchConnectionResources(input);

		expect(resources).toBeDefined();
		expect(resources!.stayCandidates).toHaveLength(2);
		expect(resources!.stayCandidates.map((s) => s.property.name)).toEqual(['Cheap Female Dorm', 'Pricier Mixed Dorm']);
		// Cheapest-first, unfiltered — the selected stay is the cheapest SELECTABLE one, which
		// is not necessarily stayCandidates[0].
		expect(resources!.stay.property.name).toBe('Pricier Mixed Dorm');
	});
});
