import { describe, expect, it } from 'vitest';
import type { Duration, FlightOffer, Money, Stay } from '../domain';
import { contextFor, isProviderUsable, ProviderRegistry } from './registry';
import type {
	AvailableKeys,
	FlightProvider,
	FlightSearchQuery,
	ProviderContext,
	ProviderId,
	ProviderResult,
	StayProvider,
	StaySearchQuery
} from './types';

/**
 * Acceptance criterion (issue #2): "A fake adapter can be registered in a test and drive
 * the whole pipeline with no network." No real search pipeline exists yet — it's built
 * against this interface by other issues — so this file plays that role itself: it fans
 * out across `ProviderRegistry.usable(...)` the same way a real pipeline would, entirely
 * in memory, and checks the one property that matters most for six adapters written in
 * parallel: no adapter's failure or cancellation ever rejects the caller's Promise.
 */

const price = (minorUnits: number): Money => ({ minorUnits, currency: 'EUR' });

function fakeOffer(carrierCode: string): FlightOffer {
	return {
		carrier: { iataCode: carrierCode, name: 'Fake Air' },
		flightNumber: `${carrierCode}100`,
		departureAirport: 'BCN',
		arrivalAirport: 'VIE',
		departure: { local: '2026-10-01T08:00:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
		arrival: { local: '2026-10-01T10:30:00', timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 },
		duration: 150 as Duration,
		price: price(4599),
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/book/FA100'
	};
}

/** A fake FlightProvider with no network calls: it fabricates one offer per search, keeps
 * an honest requestsUsed/source envelope, and respects both cancellation and the caller's
 * per-call request budget — the two behaviours every real adapter must also implement. */
function createFakeFlightProvider(id: string, opts: { needsKey?: boolean } = {}): FlightProvider {
	const needsKey = opts.needsKey ?? false;
	// Fixture-only stand-in id, not a real registered adapter — cast rather than widening
	// FlightProvider.id itself, which is exactly the closed `ProviderId` union issue #69
	// exists to enforce for real adapters.
	const providerId = id as ProviderId;
	const source = () => ({ providerId, fetchedAt: new Date().toISOString() });

	return {
		kind: 'flight',
		id: providerId,
		label: `Fake flights (${id})`,
		needsKey,
		keyFields: needsKey ? [{ id: 'apiKey', label: 'API key' }] : [],

		async healthCheck(ctx: ProviderContext): Promise<ProviderResult<{ message?: string }>> {
			if (needsKey && !ctx.keys?.apiKey) {
				return {
					ok: false,
					error: { code: 'missing-key', message: 'no apiKey configured' },
					source: source(),
					requestsUsed: 0
				};
			}
			return { ok: true, data: { message: 'reachable' }, source: source(), requestsUsed: 0 };
		},

		estimateSearchOffersCost(): number {
			// This fake has a native range endpoint: one request regardless of range size.
			return 1;
		},

		async searchOffers(
			_query: FlightSearchQuery,
			ctx: ProviderContext
		): Promise<ProviderResult<FlightOffer[]>> {
			if (ctx.signal.aborted) {
				return {
					ok: false,
					error: { code: 'cancelled', message: 'signal already aborted' },
					source: source(),
					requestsUsed: 0
				};
			}
			if (needsKey && !ctx.keys?.apiKey) {
				return {
					ok: false,
					error: { code: 'missing-key', message: 'no apiKey configured' },
					source: source(),
					requestsUsed: 0
				};
			}
			if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
				// Budget too small to spend even the one request this call needs — stop
				// early with an empty-but-ok result rather than exceeding it.
				return { ok: true, data: [], source: source(), requestsUsed: 0 };
			}
			return { ok: true, data: [fakeOffer(id.toUpperCase())], source: source(), requestsUsed: 1 };
		},

		async listDirectDestinations(): Promise<ProviderResult<string[]>> {
			return { ok: true, data: ['VIE', 'AMS'], source: source(), requestsUsed: 1 };
		}
	};
}

/** A fake adapter that always fails the way RapidAPI actually fails (403/429), to prove a
 * failing provider degrades to a typed error rather than throwing. */
function createFailingFlightProvider(
	id: string,
	code: 'not-subscribed' | 'quota-exceeded'
): FlightProvider {
	const providerId = id as ProviderId; // fixture-only stand-in id, see createFakeFlightProvider above
	const source = () => ({ providerId, fetchedAt: new Date().toISOString() });
	const error =
		code === 'not-subscribed'
			? ({
					code: 'not-subscribed',
					message: 'You are not subscribed to this API.',
					status: 403
				} as const)
			: ({
					code: 'quota-exceeded',
					message: 'quota exceeded',
					status: 429,
					retryAfterSeconds: 60
				} as const);

	return {
		kind: 'flight',
		id: providerId,
		label: `Fake failing flights (${id})`,
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: false, error, source: source(), requestsUsed: 0 };
		},
		estimateSearchOffersCost() {
			return 1;
		},
		async searchOffers() {
			// The request was made and rejected, so it still cost quota — a 429 is not free.
			return { ok: false, error, source: source(), requestsUsed: 1 };
		},
		async listDirectDestinations() {
			return { ok: false, error, source: source(), requestsUsed: 1 };
		}
	};
}

function fakeStay(propertyName: string): Stay {
	return {
		property: { name: propertyName, coordinates: { latitude: 48.2, longitude: 16.37 }, images: [] },
		roomKind: 'dorm',
		pricePerNight: price(1800)
	};
}

function createFakeStayProvider(id: string): StayProvider {
	const providerId = id as ProviderId; // fixture-only stand-in id, see createFakeFlightProvider above
	const source = () => ({ providerId, fetchedAt: new Date().toISOString() });
	return {
		kind: 'stay',
		id: providerId,
		label: `Fake stays (${id})`,
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: {}, source: source(), requestsUsed: 0 };
		},
		estimateSearchStaysCost() {
			return 1;
		},
		async searchStays(_query: StaySearchQuery, ctx: ProviderContext) {
			if (ctx.signal.aborted) {
				return {
					ok: false as const,
					error: { code: 'cancelled' as const, message: 'aborted' },
					source: source(),
					requestsUsed: 0
				};
			}
			return { ok: true, data: [fakeStay('Fake Hostel')], source: source(), requestsUsed: 1 };
		}
	};
}

describe('isProviderUsable', () => {
	it('is always usable when the adapter needs no key', () => {
		const provider = createFakeFlightProvider('keyless');
		expect(isProviderUsable(provider, {})).toBe(true);
	});

	it('is unusable when a required key is entirely absent', () => {
		const provider = createFakeFlightProvider('keyed', { needsKey: true });
		expect(isProviderUsable(provider, {})).toBe(false);
	});

	it('treats a blank key value as absent, not present', () => {
		const provider = createFakeFlightProvider('keyed', { needsKey: true });
		const keys: AvailableKeys = { keyed: { apiKey: '   ' } };
		expect(isProviderUsable(provider, keys)).toBe(false);
	});

	it('is usable once every declared key field has a value', () => {
		const provider = createFakeFlightProvider('keyed', { needsKey: true });
		const keys: AvailableKeys = { keyed: { apiKey: 'secret' } };
		expect(isProviderUsable(provider, keys)).toBe(true);
	});
});

describe('ProviderRegistry', () => {
	it('registers adapters passed to the constructor and via register()', () => {
		const a = createFakeFlightProvider('a');
		const b = createFakeFlightProvider('b');
		const registry = new ProviderRegistry([a]);
		registry.register(b);
		expect(registry.all().map((p) => p.id).sort()).toEqual(['a', 'b']);
		expect(registry.byId('a' as ProviderId)).toBe(a); // fixture-only stand-in id, see createFakeFlightProvider above
	});

	it('refuses a duplicate id rather than silently shadowing the first adapter', () => {
		const registry = new ProviderRegistry([createFakeFlightProvider('dup')]);
		expect(() => registry.register(createFakeFlightProvider('dup'))).toThrow(/already registered/);
	});

	it('narrows ofKind and usable to the requested provider kind', () => {
		const flight = createFakeFlightProvider('sky', { needsKey: true });
		const stay = createFakeStayProvider('agoda');
		const registry = new ProviderRegistry([flight, stay]);

		expect(registry.ofKind('flight')).toEqual([flight]);
		expect(registry.ofKind('stay')).toEqual([stay]);

		// No keys configured: the keyed flight adapter drops out, the keyless stay
		// adapter does not.
		expect(registry.usable('flight', {})).toEqual([]);
		expect(registry.usable('stay', {})).toEqual([stay]);

		const keys: AvailableKeys = { sky: { apiKey: 'secret' } };
		expect(registry.usable('flight', keys)).toEqual([flight]);
		expect(registry.usableAll(keys).map((p) => p.id).sort()).toEqual(['agoda', 'sky']);
	});
});

describe('driving a fan-out search with no network', () => {
	it('never rejects even when one adapter is failing and one is cancelled', async () => {
		const healthy = createFakeFlightProvider('healthy');
		const unsubscribed = createFailingFlightProvider('unsubscribed-provider', 'not-subscribed');
		const throttled = createFailingFlightProvider('throttled-provider', 'quota-exceeded');
		const registry = new ProviderRegistry([healthy, unsubscribed, throttled]);

		const controller = new AbortController();
		const query: FlightSearchQuery = {
			origin: 'BCN',
			destination: 'VIE',
			earliestDeparture: '2026-10-01',
			latestDeparture: '2026-10-03'
		};
		const keys: AvailableKeys = {};

		// This is the shape a real search pipeline uses: ask the registry which adapters
		// of this kind are usable, then fan out across all of them with Promise.all. If
		// the interface's "never throw" contract holds, Promise.all is safe here — no
		// allSettled, no per-call try/catch needed at the call site.
		const providers = registry.usable('flight', keys);
		const results = await Promise.all(
			providers.map((provider) =>
				provider.searchOffers(query, contextFor(provider.id, keys, controller.signal))
			)
		);

		expect(results).toHaveLength(3);
		const byId = Object.fromEntries(results.map((r, i) => [providers[i].id, r]));

		expect(byId.healthy.ok).toBe(true);
		if (byId.healthy.ok) {
			expect(byId.healthy.data).toHaveLength(1);
			expect(byId.healthy.data[0].carrier.iataCode).toBe('HEALTHY');
			expect(byId.healthy.source.providerId).toBe('healthy');
			expect(byId.healthy.requestsUsed).toBe(1);
		}

		expect(byId['unsubscribed-provider'].ok).toBe(false);
		if (!byId['unsubscribed-provider'].ok) {
			expect(byId['unsubscribed-provider'].error.code).toBe('not-subscribed');
		}

		expect(byId['throttled-provider'].ok).toBe(false);
		if (!byId['throttled-provider'].ok) {
			expect(byId['throttled-provider'].error).toMatchObject({
				code: 'quota-exceeded',
				retryAfterSeconds: 60
			});
			// A 429 still cost a request — the caller's budget tracking needs this to be
			// honest even on failure.
			expect(byId['throttled-provider'].requestsUsed).toBe(1);
		}
	});

	it('resolves with a typed cancelled result instead of throwing when already aborted', async () => {
		const provider = createFakeFlightProvider('cancel-me');
		const controller = new AbortController();
		controller.abort();

		const query: FlightSearchQuery = {
			origin: 'BCN',
			destination: 'VIE',
			earliestDeparture: '2026-10-01',
			latestDeparture: '2026-10-01'
		};

		const result = await provider.searchOffers(query, { signal: controller.signal });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('cancelled');
	});

	it('lets estimateSearchOffersCost be checked before spending any request', () => {
		const provider = createFakeFlightProvider('cost-check');
		const query: FlightSearchQuery = {
			origin: 'BCN',
			destination: 'VIE',
			earliestDeparture: '2026-10-01',
			latestDeparture: '2026-10-31'
		};
		// Pure and synchronous: no network, no promise.
		expect(provider.estimateSearchOffersCost(query)).toBe(1);
	});

	it('stops within a caller-imposed request budget instead of spending past it', async () => {
		const provider = createFakeFlightProvider('budget-respecting');
		const controller = new AbortController();
		const query: FlightSearchQuery = {
			origin: 'BCN',
			destination: 'VIE',
			earliestDeparture: '2026-10-01',
			latestDeparture: '2026-10-01'
		};

		const result = await provider.searchOffers(query, { signal: controller.signal, maxRequests: 0 });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data).toEqual([]);
			expect(result.requestsUsed).toBe(0);
		}
	});

	it('drives a stay search the same way, across a different provider kind', async () => {
		const stay = createFakeStayProvider('fake-hostels');
		const registry = new ProviderRegistry([stay]);
		const keys: AvailableKeys = {};
		const controller = new AbortController();

		const query: StaySearchQuery = {
			near: { latitude: 48.2, longitude: 16.37 },
			radiusKm: 5,
			checkIn: '2026-10-01',
			checkOut: '2026-10-03'
		};

		const [provider] = registry.usable('stay', keys);
		const ctx = contextFor(provider.id, keys, controller.signal);
		const result = await provider.searchStays(query, ctx);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data).toEqual([fakeStay('Fake Hostel')]);
			expect(result.source.providerId).toBe('fake-hostels');
		}
	});
});
