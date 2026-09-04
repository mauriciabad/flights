/**
 * Issue #80: `fetchConnectionResources` (and `fetchCheapestStay` underneath it) must never
 * hand a `female-dorm` to a party that cannot fully use one, no matter how much cheaper it
 * is than every other option, and must keep every `Stay` it found — not just the one it
 * picked — so a caller can offer real alternatives (issue #27's stay picker).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Duration, IsoCountryCode, LandingToTransportRule, Stay, Transfer } from '../domain';
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
import { recordProviderResult, SourceTracker } from './provenance';
import type { ProviderStatus } from './types';
import type { TaxiFareEstimate } from '../providers/transfers/taxi-rate-table';

// Issue #114: `resources.ts` reaches past the generic `TransferProvider` interface into
// osrm.ts's own `getTaxiFareEstimate` for a taxi fare range (see `estimateTaxiFareForLeg`'s
// own doc comment for why). Mocking just that one export — keeping every other real export
// (`OSRM_PROVIDER_ID` included) — lets these tests assert exactly when that call happens
// without hitting the real OSRM network or its cache.
const getTaxiFareEstimate = vi.fn();
vi.mock('../providers/transfers/osrm', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../providers/transfers/osrm')>();
	return { ...actual, getTaxiFareEstimate };
});

// Imported after the mock is registered, per vitest's hoisting contract for vi.mock (same
// pattern as providers-adapter.test.ts).
const { fetchConnectionResources } = await import('./resources');

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

/** Issue #114: unlike `fakeTransferProvider` above (always exactly one hardcoded transit
 * `Transfer`), this fixture's response is configurable — needed to exercise "every mode
 * found is kept as a candidate" and "a taxi candidate triggers a fare estimate lookup"
 * against more than one hardcoded shape. */
function configurableTransferProvider(transfers: Transfer[], idString = 'transfer-fixture'): TransferProvider {
	const id = idString as ProviderId; // fixture-only stand-in id, see source() above
	return {
		kind: 'transfer',
		id,
		label: `Fixture transfers (${idString})`,
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: {}, source: source(idString), requestsUsed: 0 };
		},
		async searchTransfers(_query: TransferSearchQuery, ctx: ProviderContext): Promise<ProviderResult<Transfer[]>> {
			if (ctx.signal.aborted) {
				return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: source(idString), requestsUsed: 0 };
			}
			return { ok: true, data: transfers, source: source(idString), requestsUsed: 1 };
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
	extra: {
		travellers?: number;
		females?: number;
		transferProviders?: readonly TransferProvider[];
		connectionCountryCode?: IsoCountryCode;
		landingToTransportRules?: readonly LandingToTransportRule[];
	} = {}
) {
	const { record, sources } = newTracking();
	const keys: AvailableKeys = {};
	const controller = new AbortController();
	return {
		connectionCoordinates: CONNECTION_COORDINATES,
		connectionAirportSize: 'medium' as const,
		stayProviders,
		transferProviders: extra.transferProviders ?? [fakeTransferProvider()],
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

		expect(resources.stay?.roomKind).not.toBe('female-dorm');
		expect(resources.stay?.property.name).toBe('Pricier Mixed Dorm');
	});

	it('degrades to no priced stay, without dropping the candidate, when the only stay found is a female-only dorm a zero-female group cannot use', async () => {
		const stays = [stay('Only Female Dorm', 'female-dorm', 1000)];
		const input = baseInput([fakeStayProvider('stays', stays)], { travellers: 2, females: 0 });

		const resources = await fetchConnectionResources(input);

		// Never falls back to pricing a bed nobody in the party can book — no stay reachable
		// is the same "no usable stay" outcome as no stay found at all (issue #94: this no
		// longer discards the whole candidate, only its stay/transfer trio).
		expect(resources.stay).toBeUndefined();
		expect(resources.transferToHotel).toBeUndefined();
		expect(resources.transferToConnectionAirport).toBeUndefined();
		// Still kept, ineligible or not — a caller offering alternatives doesn't need the
		// pick to have succeeded to list what was found.
		expect(resources.stayCandidates).toHaveLength(1);
	});

	it('still selects a female-only dorm for a mixed group when it is cheapest, if females is unspecified', async () => {
		const stays = [stay('Cheap Female Dorm', 'female-dorm', 1000), stay('Pricier Mixed Dorm', 'dorm', 2200)];
		// females omitted entirely — absent means "do not filter", not the same as 0
		// (domain/search-query.ts's own doc comment).
		const input = baseInput([fakeStayProvider('stays', stays)], { travellers: 4 });

		const resources = await fetchConnectionResources(input);

		expect(resources.stay?.roomKind).toBe('female-dorm');
		expect(resources.stay?.property.name).toBe('Cheap Female Dorm');
	});

	it('selects a female-only dorm normally when the whole group is female', async () => {
		const stays = [stay('Cheap Female Dorm', 'female-dorm', 1000), stay('Pricier Mixed Dorm', 'dorm', 2200)];
		const input = baseInput([fakeStayProvider('stays', stays)], { travellers: 2, females: 2 });

		const resources = await fetchConnectionResources(input);

		expect(resources.stay?.roomKind).toBe('female-dorm');
	});

	it('keeps every stay found in `stayCandidates`, ineligible ones included, not just the chosen one', async () => {
		const stays = [stay('Cheap Female Dorm', 'female-dorm', 1000), stay('Pricier Mixed Dorm', 'dorm', 2200)];
		const input = baseInput([fakeStayProvider('stays', stays)], { travellers: 4, females: 0 });

		const resources = await fetchConnectionResources(input);

		expect(resources.stayCandidates).toHaveLength(2);
		expect(resources.stayCandidates.map((s) => s.property.name)).toEqual(['Cheap Female Dorm', 'Pricier Mixed Dorm']);
		// Cheapest-first, unfiltered — the selected stay is the cheapest SELECTABLE one, which
		// is not necessarily stayCandidates[0].
		expect(resources.stay?.property.name).toBe('Pricier Mixed Dorm');
	});
});

describe('fetchConnectionResources: missing stay is degraded, not dropped (issue #94)', () => {
	it('returns flights-ready resources with no stay when every stay provider returns nothing', async () => {
		const input = baseInput([fakeStayProvider('stays', [])]);

		const resources = await fetchConnectionResources(input);

		expect(resources.stay).toBeUndefined();
		expect(resources.transferToHotel).toBeUndefined();
		expect(resources.transferToConnectionAirport).toBeUndefined();
		expect(resources.stayCandidates).toEqual([]);
	});

	it('returns flights-ready resources with no stay when there is no stay provider at all', async () => {
		const input = baseInput([]);

		const resources = await fetchConnectionResources(input);

		expect(resources.stay).toBeUndefined();
		expect(resources.stayCandidates).toEqual([]);
	});

	/** Mirrors the real Agoda/Booking shape (docs/PROVIDERS.md): `needsKey: true`, a small
	 * positive cost per search, and the same `ProviderId` `../providers/budget/caps.ts`'s
	 * `DEFAULT_PROVIDER_CAPS` tunes a generous cap for — the whole point of this fixture is
	 * to exercise the REAL quota-generosity math, not a fixture-only cap. */
	function fakeMeteredStayProvider(id: 'agoda' | 'booking', stays: Stay[]): StayProvider {
		return {
			kind: 'stay',
			id,
			label: `Fixture metered stays (${id})`,
			needsKey: true,
			keyFields: [{ id: 'apiKey', label: 'API key' }],
			async healthCheck() {
				return { ok: true, data: {}, source: source(id), requestsUsed: 0 };
			},
			// Real Agoda/Booking adapters cost `1 + MAX_CANDIDATES_TO_EXPAND` — using their
			// real numbers here (6, 2) is what proves this test against the real cap table
			// rather than a number chosen to make the test pass.
			estimateSearchStaysCost: () => (id === 'agoda' ? 6 : 2),
			async searchStays(_query: StaySearchQuery, ctx: ProviderContext): Promise<ProviderResult<Stay[]>> {
				if (ctx.signal.aborted) {
					return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: source(id), requestsUsed: 0 };
				}
				return { ok: true, data: stays, source: source(id), requestsUsed: 1 };
			}
		};
	}

	it('runs a keyed, quota-generous metered stay provider (Agoda-shaped) with no second opt-in', async () => {
		const stays = [stay('Vienna Hostel', 'dorm', 2500)];
		const provider = fakeMeteredStayProvider('agoda', stays);
		const { record, sources } = newTracking();
		const input = {
			connectionCoordinates: CONNECTION_COORDINATES,
			connectionAirportSize: 'medium' as const,
			stayProviders: [provider],
			transferProviders: [fakeTransferProvider()],
			keys: { agoda: { apiKey: 'a-real-key' } } as AvailableKeys,
			signal: new AbortController().signal,
			stayRadiusKm: 100,
			checkIn: '2026-10-01' as const,
			checkOut: '2026-10-03' as const,
			landingToTransportRules: [],
			sources,
			record
		};

		const resources = await fetchConnectionResources(input);

		// No `widenTo` was ever passed in by this test — the pipeline layer above never asks
		// for one either (issue #94). A key alone was enough.
		expect(resources.stay?.property.name).toBe('Vienna Hostel');
		expect(resources.transferToHotel).toBeDefined();
	});

	it('never runs a keyed metered stay provider with no configured key', async () => {
		const provider = fakeMeteredStayProvider('booking', [stay('Ibis Airport', 'private', 8000)]);
		const input = baseInput([provider]); // baseInput's `keys` is `{}` — no key configured

		const resources = await fetchConnectionResources(input);

		expect(resources.stay).toBeUndefined();
	});
});

describe('fetchConnectionResources: transfer candidates for both connection-side legs (issue #114)', () => {
	it('keeps every transfer mode a provider returned, not just the one pick build.ts uses', async () => {
		const stays = [stay('Hostel', 'dorm', 2000)];
		const walk: Transfer = { mode: 'walk', duration: 30 as Duration, legs: [] };
		const transit: Transfer = { mode: 'transit', duration: 20 as Duration, legs: [] };
		const input = baseInput([fakeStayProvider('stays', stays)], {
			transferProviders: [configurableTransferProvider([walk, transit])]
		});

		const resources = await fetchConnectionResources(input);

		expect(resources.transferToHotelCandidates.map((t) => t.mode).sort()).toEqual(['transit', 'walk']);
		expect(resources.transferToConnectionAirportCandidates.map((t) => t.mode).sort()).toEqual(['transit', 'walk']);
		// Mode preference (real transit over walking) still decides the pick, unaffected by
		// keeping the rest around as alternatives.
		expect(resources.transferToHotel?.mode).toBe('transit');
		expect(resources.transferToConnectionAirport?.mode).toBe('transit');
	});

	it('applies the landing-to-transport buffer to every hotel-bound candidate, not only the pick', async () => {
		const stays = [stay('Hostel', 'dorm', 2000)];
		const walk: Transfer = { mode: 'walk', duration: 30 as Duration, legs: [] };
		const transit: Transfer = { mode: 'transit', duration: 20 as Duration, legs: [] };
		const input = baseInput([fakeStayProvider('stays', stays)], {
			transferProviders: [configurableTransferProvider([walk, transit])],
			landingToTransportRules: [{ time: 15 as Duration }]
		});

		const resources = await fetchConnectionResources(input);

		// A traveller who picks a different mode via TransportPicker still needs the same
		// "time to actually reach the street" padding the pipeline's own choice gets.
		const hotelByMode = new Map(resources.transferToHotelCandidates.map((t) => [t.mode, t.duration]));
		expect(hotelByMode.get('walk')).toBe(45);
		expect(hotelByMode.get('transit')).toBe(35);
		// The return leg (hotel back to the connection airport) never gets this buffer — it
		// ends at a departure, not a runway (resources.ts's own `applyLandingBuffer` comment).
		const returnByMode = new Map(resources.transferToConnectionAirportCandidates.map((t) => [t.mode, t.duration]));
		expect(returnByMode.get('walk')).toBe(30);
		expect(returnByMode.get('transit')).toBe(20);
	});

	it('reports no candidates for either leg once a stay could not be reached', async () => {
		const input = baseInput([fakeStayProvider('stays', [])]); // no stay found at all

		const resources = await fetchConnectionResources(input);

		expect(resources.transferToHotelCandidates).toEqual([]);
		expect(resources.transferToConnectionAirportCandidates).toEqual([]);
	});
});

describe('fetchConnectionResources: taxi fare estimate wiring (issue #114)', () => {
	beforeEach(() => {
		getTaxiFareEstimate.mockReset();
	});

	function fareEstimate(): TaxiFareEstimate {
		return {
			kind: 'estimate',
			currency: 'EUR',
			lowMinorUnits: 1800,
			highMinorUnits: 2400,
			countryCode: 'AT',
			rateSource: 'country',
			citation: 'Test citation'
		};
	}

	it('asks OSRM for a taxi fare estimate on both legs when a taxi candidate and a country code are both present', async () => {
		getTaxiFareEstimate.mockResolvedValue({
			ok: true,
			data: { duration: 15 as Duration, distanceMeters: 5000, fareEstimate: fareEstimate() },
			source: source('osrm'),
			requestsUsed: 0
		});
		const stays = [stay('Hostel', 'dorm', 2000)];
		const taxi: Transfer = { mode: 'taxi', duration: 15 as Duration, legs: [] };
		const input = baseInput([fakeStayProvider('stays', stays)], {
			transferProviders: [configurableTransferProvider([taxi])],
			connectionCountryCode: 'AT'
		});

		const resources = await fetchConnectionResources(input);

		// Once for the hotel-bound leg, once for the return leg — never more, since each is
		// a cache hit on a route `searchTransfers` already fetched (see
		// `estimateTaxiFareForLeg`'s own doc comment; the cache-hit behaviour itself is
		// verified directly in osrm.test.ts).
		expect(getTaxiFareEstimate).toHaveBeenCalledTimes(2);
		expect(resources.transferToHotelTaxiFareEstimate).toEqual(fareEstimate());
		expect(resources.transferToConnectionAirportTaxiFareEstimate).toEqual(fareEstimate());
	});

	it('never asks OSRM for an estimate when no taxi candidate came back for this leg', async () => {
		const stays = [stay('Hostel', 'dorm', 2000)];
		const walk: Transfer = { mode: 'walk', duration: 30 as Duration, legs: [] };
		const input = baseInput([fakeStayProvider('stays', stays)], {
			transferProviders: [configurableTransferProvider([walk])],
			connectionCountryCode: 'AT'
		});

		const resources = await fetchConnectionResources(input);

		expect(getTaxiFareEstimate).not.toHaveBeenCalled();
		expect(resources.transferToHotelTaxiFareEstimate).toBeUndefined();
		expect(resources.transferToConnectionAirportTaxiFareEstimate).toBeUndefined();
	});

	it('never asks OSRM for an estimate when this connection has no known country code', async () => {
		const stays = [stay('Hostel', 'dorm', 2000)];
		const taxi: Transfer = { mode: 'taxi', duration: 15 as Duration, legs: [] };
		const input = baseInput([fakeStayProvider('stays', stays)], {
			transferProviders: [configurableTransferProvider([taxi])]
			// connectionCountryCode intentionally omitted
		});

		const resources = await fetchConnectionResources(input);

		expect(getTaxiFareEstimate).not.toHaveBeenCalled();
		expect(resources.transferToHotelTaxiFareEstimate).toBeUndefined();
	});
});
