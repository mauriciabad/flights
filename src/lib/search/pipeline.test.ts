import { describe, expect, it, vi } from 'vitest';
import type {
	Airport,
	City,
	Country,
	Duration,
	FlightOffer,
	LocalDateTime,
	SearchQuery,
	Stay,
	Transfer
} from '../domain';
import { ProviderRegistry } from '../providers/registry';
import type {
	AvailableKeys,
	FlightProvider,
	FlightSearchQuery,
	ProviderContext,
	ProviderId,
	ProviderResult,
	ProviderSource,
	StayProvider,
	StaySearchQuery,
	TransferProvider,
	TransferSearchQuery
} from '../providers/types';
import { runSearch, widenSearch, widenWithPriceCalendar } from './pipeline';
import type { FlightsSkyProvider, PriceCalendarQuery } from './price-calendar';
import type { SearchDependencies, SearchSnapshot } from './types';

/**
 * Acceptance-test fixture geometry (issue #56). Coordinates mirror
 * `algorithm/connections.test.ts`'s own verified fixture (Barcelona/Vienna/Milan/Sofia real
 * coordinates under fictional Z-prefixed codes) so both connection candidates clear the
 * default detour-ratio filter without this file having to re-derive that math. Fictional
 * codes matter here for the same reason that file gives: real IATA codes would silently pick
 * up extra edges from `connections-fallback-data.ts`'s bundled route table, making a test
 * about THIS fixture's providers actually depend on that table's contents too.
 */
const ORIGIN = 'ZOR';
const DEST = 'ZDE';
const FAST = 'ZFA'; // stands in for Vienna: detour ratio ~1.23
const SLOW = 'ZSL'; // stands in for Milan: detour ratio ~1.10

const country = (isoCode: string, name: string): Country => ({ isoCode, name });
const city = (name: string, lat: number, lon: number, c: Country): City => ({
	name,
	coordinates: { latitude: lat, longitude: lon },
	country: c
});

function airport(code: string, lat: number, lon: number, countryCode: string, cityName: string): Airport {
	const c = country(countryCode, countryCode);
	return {
		iataCode: code,
		name: `${code} airport`,
		coordinates: { latitude: lat, longitude: lon },
		city: city(cityName, lat, lon, c),
		country: c,
		sizeClass: 'medium'
	};
}

const AIRPORTS: Record<string, Airport> = {
	[ORIGIN]: airport(ORIGIN, 41.2971, 2.0785, 'ES', 'Origin City'),
	[DEST]: airport(DEST, 42.6952, 23.4062, 'BG', 'Destination City'),
	[FAST]: airport(FAST, 48.1103, 16.5697, 'AT', 'Fast City'),
	[SLOW]: airport(SLOW, 45.6306, 8.7281, 'IT', 'Slow City')
};

function resolveAirport(code: string): Airport | undefined {
	return AIRPORTS[code];
}

function localDateTime(local: string, timeZone: string, utcOffsetMinutes: number): LocalDateTime {
	return { local, timeZone, utcOffsetMinutes };
}

function flightOffer(
	carrierCode: string,
	departureAirport: string,
	arrivalAirport: string,
	departure: LocalDateTime,
	arrival: LocalDateTime,
	duration: number
): FlightOffer {
	return {
		carrier: { iataCode: carrierCode, name: 'Fixture Air' },
		flightNumber: `${carrierCode}1`,
		departureAirport,
		arrivalAirport,
		departure,
		arrival,
		duration: duration as Duration,
		price: { minorUnits: 4500, currency: 'EUR' },
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	};
}

/**
 * A buildable outbound leg (`origin -> some candidate`), fixed times regardless of which
 * candidate is plugged into `arrivalAirport` — only the airport codes vary between
 * candidates in these fixtures, never the schedule.
 */
function outboundOffer(departureAirport: string, arrivalAirport: string): FlightOffer {
	return flightOffer(
		'FA',
		departureAirport,
		arrivalAirport,
		localDateTime('2026-10-01T08:00:00', 'Europe/Madrid', 120),
		localDateTime('2026-10-01T10:30:00', 'Europe/Vienna', 120),
		150
	);
}

/** The matching onward leg (`some candidate -> destination`) — departs long enough after
 * `outboundOffer`'s arrival to clear the minimum layover and leave positive free time once
 * the fixture's stay/transfer buffers (see `createFakeTransferProvider`) are subtracted. */
function onwardOffer(departureAirport: string, arrivalAirport: string): FlightOffer {
	return flightOffer(
		'FA',
		departureAirport,
		arrivalAirport,
		localDateTime('2026-10-02T09:00:00', 'Europe/Vienna', 120),
		localDateTime('2026-10-02T11:00:00', 'Europe/Sofia', 180),
		120
	);
}

/** The offer builder every "just make a working search" fixture below uses: an outbound leg
 * for any query starting at `ORIGIN`, an onward leg for any query ending at `DEST`, agnostic
 * to which specific connection airport sits in between — so the same builder handles both
 * `FAST` and `SLOW` without per-candidate special-casing. */
function standardOfferBuilder(query: FlightSearchQuery): FlightOffer[] {
	if (query.origin === ORIGIN) return [outboundOffer(query.origin, query.destination)];
	if (query.destination === DEST) return [onwardOffer(query.origin, query.destination)];
	return [];
}

// Every id passed through here is a fixture-only stand-in, not a real registered adapter —
// cast rather than widening ProviderSource.providerId itself, which is exactly the closed
// `ProviderId` union issue #69 exists to enforce for real adapters.
function source(providerId: string): ProviderSource {
	return { providerId: providerId as ProviderId, fetchedAt: new Date().toISOString() };
}

interface FlightFixture {
	provider: FlightProvider;
	searchOffers: ReturnType<typeof vi.fn>;
	listDirectDestinations: ReturnType<typeof vi.fn>;
}

/**
 * A configurable fake `FlightProvider`. `routes` backs `listDirectDestinations`;
 * `offerBuilder` decides what `searchOffers` returns for a given leg (defaulting to always
 * empty, since most fixtures below only care about one provider actually producing offers).
 */
function createFakeFlightProvider(options: {
	id: string;
	needsKey?: boolean;
	/** A flat number (the common case in these fixtures) or, for a test that needs the real
	 * "one request per date" shape (Sky Scrapper's actual behaviour), a function of the
	 * query. */
	costPerQuery?: number | ((query: FlightSearchQuery) => number);
	routes: Record<string, string[]>;
	offerBuilder?: (query: FlightSearchQuery) => FlightOffer[] | Promise<FlightOffer[]>;
	alwaysFails?: boolean;
}): FlightFixture {
	const needsKey = options.needsKey ?? false;
	const cost = options.costPerQuery ?? 0;
	const estimateCost = (query: FlightSearchQuery): number => (typeof cost === 'function' ? cost(query) : cost);

	const searchOffers = vi.fn(async (query: FlightSearchQuery, ctx: ProviderContext): Promise<ProviderResult<FlightOffer[]>> => {
		if (ctx.signal.aborted) {
			return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: source(options.id), requestsUsed: 0 };
		}
		if (options.alwaysFails) {
			return {
				ok: false,
				error: { code: 'network-error', message: 'fixture failure' },
				source: source(options.id),
				requestsUsed: 0
			};
		}
		const data = options.offerBuilder ? await options.offerBuilder(query) : [];
		return { ok: true, data, source: source(options.id), requestsUsed: 1 };
	});

	const listDirectDestinations = vi.fn(
		async (code: string, ctx: ProviderContext): Promise<ProviderResult<string[]>> => {
			if (ctx.signal.aborted) {
				return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: source(options.id), requestsUsed: 0 };
			}
			return { ok: true, data: [...(options.routes[code] ?? [])], source: source(options.id), requestsUsed: 1 };
		}
	);

	const provider: FlightProvider = {
		kind: 'flight',
		id: options.id as ProviderId, // fixture-only stand-in id, see source() above
		label: `Fixture flights (${options.id})`,
		needsKey,
		keyFields: needsKey ? [{ id: 'apiKey', label: 'API key' }] : [],
		async healthCheck() {
			return { ok: true, data: {}, source: source(options.id), requestsUsed: 0 };
		},
		estimateSearchOffersCost: estimateCost,
		searchOffers,
		listDirectDestinations
	};

	return { provider, searchOffers, listDirectDestinations };
}

function fakeStay(name: string, coordinates: { latitude: number; longitude: number }): Stay {
	return { property: { name, coordinates, images: [] }, roomKind: 'dorm', pricePerNight: { minorUnits: 2000, currency: 'EUR' } };
}

function createFakeStayProvider(options: {
	id: string;
	gate?: { promise: Promise<void>; appliesTo?: (query: StaySearchQuery) => boolean };
}): StayProvider {
	return {
		kind: 'stay',
		id: options.id as ProviderId, // fixture-only stand-in id, see source() above
		label: `Fixture stays (${options.id})`,
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: {}, source: source(options.id), requestsUsed: 0 };
		},
		estimateSearchStaysCost: () => 0,
		async searchStays(query: StaySearchQuery, ctx: ProviderContext): Promise<ProviderResult<Stay[]>> {
			if (options.gate && (options.gate.appliesTo?.(query) ?? true)) {
				await options.gate.promise;
			}
			if (ctx.signal.aborted) {
				return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: source(options.id), requestsUsed: 0 };
			}
			return { ok: true, data: [fakeStay(`${options.id} stay`, query.near)], source: source(options.id), requestsUsed: 1 };
		}
	};
}

function createFakeTransferProvider(id = 'transit-fixture'): TransferProvider {
	const transfer = (): Transfer => ({ mode: 'transit', duration: 20 as Duration, legs: [] });
	return {
		kind: 'transfer',
		id: id as ProviderId, // fixture-only stand-in id, see source() above
		label: `Fixture transfers (${id})`,
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: {}, source: source(id), requestsUsed: 0 };
		},
		async searchTransfers(_query: TransferSearchQuery, ctx: ProviderContext): Promise<ProviderResult<Transfer[]>> {
			if (ctx.signal.aborted) {
				return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: source(id), requestsUsed: 0 };
			}
			return { ok: true, data: [transfer()], source: source(id), requestsUsed: 1 };
		}
	};
}

const BASE_QUERY: SearchQuery = {
	soonestDeparture: '2026-10-01',
	latestArrival: '2026-10-05',
	originAirport: ORIGIN,
	destinationAirport: DEST
};

async function drain(gen: AsyncGenerator<SearchSnapshot, void, void>): Promise<SearchSnapshot[]> {
	const snapshots: SearchSnapshot[] = [];
	for await (const snapshot of gen) snapshots.push(snapshot);
	return snapshots;
}

/**
 * Pulls an already-started generator to completion via the raw `.next()` protocol rather
 * than `for await...of` sugar — needed only when a test must interleave its own actions
 * (aborting, releasing a gate) between yields, which `for await` doesn't allow. Collects the
 * *yielded* values, not the generator's own completion result: `runSearch`/`widenSearch`
 * always `yield` their terminal snapshot before an empty `return`, exactly so a `for await`
 * consumer (which discards a generator's return value) still sees it — see pipeline.ts's own
 * comment on that choice. The last element of what this returns is that terminal snapshot.
 */
/** Narrows a raw `.next()` result to its yielded `SearchSnapshot`, for a test that knows (by
 * construction) the generator hasn't completed yet — throws instead of silently reading
 * `undefined` off a completed generator's `{ done: true, value: undefined }`. */
function yielded(result: IteratorResult<SearchSnapshot, void>): SearchSnapshot {
	if (result.done) throw new Error('expected a yielded snapshot, but the generator already completed');
	return result.value;
}

async function collectRemaining(
	iterator: AsyncGenerator<SearchSnapshot, void, void>
): Promise<SearchSnapshot[]> {
	const values: SearchSnapshot[] = [];
	let result = await iterator.next();
	while (!result.done) {
		values.push(result.value);
		result = await iterator.next();
	}
	return values;
}

describe('runSearch: stage 1 spends nothing metered', () => {
	it('never calls a provider that would spend a metered request', async () => {
		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] },
			offerBuilder: standardOfferBuilder
		});
		// A per-date-cost adapter, modelled on Skyscanner: any given query costs at least 1.
		const metered = createFakeFlightProvider({
			id: 'metered-flights',
			needsKey: true,
			costPerQuery: 1,
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] }
		});

		const registry = new ProviderRegistry([
			free.provider,
			metered.provider,
			createFakeStayProvider({ id: 'stays' }),
			createFakeTransferProvider()
		]);
		const deps: SearchDependencies = { registry, keys: {}, resolveAirport, currency: 'EUR' };

		const snapshots = await drain(runSearch(BASE_QUERY, deps));

		expect(metered.listDirectDestinations).not.toHaveBeenCalled();
		expect(metered.searchOffers).not.toHaveBeenCalled();

		const final = snapshots.at(-1)!;
		expect(final.done).toBe(true);
		expect(final.itineraryGroups.length).toBeGreaterThan(0);

		// The metered provider still shows up as a widen option, at a real non-zero cost —
		// "ask what widening would cost" must work without ever spending anything.
		const meteredOption = final.widenOptions.find((option) => option.providerId === ('metered-flights' as ProviderId));
		expect(meteredOption).toBeDefined();
		expect(meteredOption!.requests).toBeGreaterThan(0);
		expect(meteredOption!.requiresKey).toBe(true); // no key configured in `deps.keys`
	});
});

describe('runSearch: one provider failing never fails the search', () => {
	it('still returns itineraries built from the surviving provider', async () => {
		const healthy = createFakeFlightProvider({
			id: 'healthy-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] },
			offerBuilder: standardOfferBuilder
		});
		const flaky = createFakeFlightProvider({
			id: 'flaky-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] },
			alwaysFails: true
		});

		const registry = new ProviderRegistry([
			healthy.provider,
			flaky.provider,
			createFakeStayProvider({ id: 'stays' }),
			createFakeTransferProvider()
		]);
		const deps: SearchDependencies = { registry, keys: {}, resolveAirport, currency: 'EUR' };

		const snapshots = await drain(runSearch(BASE_QUERY, deps));
		const final = snapshots.at(-1)!;

		expect(final.itineraryGroups.length).toBeGreaterThan(0);
		expect(final.providers['flaky-flights' as ProviderId]?.lastError?.code).toBe('network-error');
		expect(final.providers['healthy-flights' as ProviderId]?.lastError).toBeUndefined();
	});
});

describe('runSearch: cancellation stops further provider calls', () => {
	it('makes no per-candidate provider call once the signal is aborted', async () => {
		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] },
			offerBuilder: standardOfferBuilder
		});
		const registry = new ProviderRegistry([
			free.provider,
			createFakeStayProvider({ id: 'stays' }),
			createFakeTransferProvider()
		]);
		const deps: SearchDependencies = { registry, keys: {}, resolveAirport, currency: 'EUR' };

		const controller = new AbortController();
		const iterator = runSearch(BASE_QUERY, deps, { signal: controller.signal });

		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(yielded(first).stage).toBe('candidates');
		// listDirectDestinations (candidate ranking) already ran to produce this snapshot —
		// only searchOffers (per-candidate fetching, which happens after) is under test here.
		free.searchOffers.mockClear();

		controller.abort();

		// Keep pulling: a correct implementation must not start any *new* provider call
		// after this point, however many more times the caller asks.
		const rest = await collectRemaining(iterator);

		expect(free.searchOffers).not.toHaveBeenCalled();
		expect(rest.at(-1)?.done).toBe(true);
	});
});

describe('runSearch: results stream rather than arriving in one batch', () => {
	it('yields the fast candidate before the slow one resolves', async () => {
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});

		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST, SLOW], [FAST]: [DEST], [SLOW]: [DEST] },
			// standardOfferBuilder is agnostic to which candidate airport sits in the
			// middle, so it produces a valid outbound+onward pair for both FAST and SLOW.
			offerBuilder: standardOfferBuilder
		});

		// Only the SLOW candidate's stay lookup waits on the gate — everything else about
		// both candidates is free to resolve immediately.
		const stays = createFakeStayProvider({
			id: 'stays',
			gate: { promise: gate, appliesTo: (q) => q.near.longitude === AIRPORTS[SLOW].coordinates.longitude }
		});

		const registry = new ProviderRegistry([free.provider, stays, createFakeTransferProvider()]);
		const deps: SearchDependencies = { registry, keys: {}, resolveAirport, currency: 'EUR' };

		const iterator = runSearch(BASE_QUERY, deps);

		const candidatesSnapshot = await iterator.next();
		expect(yielded(candidatesSnapshot).candidates.map((c) => c.airportCode).sort()).toEqual([FAST, SLOW]);

		// The fast candidate's snapshot must be observable BEFORE the gate is released —
		// this is the actual streaming assertion, not just "more than one yield happened".
		const fastSnapshot = await iterator.next();
		expect(fastSnapshot.done).toBe(false);
		expect(yielded(fastSnapshot).itineraryGroups.map((g) => g.connectionAirportCode)).toEqual([FAST]);

		releaseGate();

		const slowSnapshot = await iterator.next();
		expect(slowSnapshot.done).toBe(false);
		expect(yielded(slowSnapshot).itineraryGroups.map((g) => g.connectionAirportCode).sort()).toEqual([FAST, SLOW]);

		const rest = await collectRemaining(iterator);
		expect(rest.at(-1)?.done).toBe(true);
	});
});

describe('runSearch: grouping and provenance', () => {
	it('carries per-field provenance and groups variants by connection airport', async () => {
		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] },
			offerBuilder: standardOfferBuilder
		});
		const registry = new ProviderRegistry([
			free.provider,
			createFakeStayProvider({ id: 'stays' }),
			createFakeTransferProvider('transit-fixture')
		]);
		const deps: SearchDependencies = { registry, keys: {}, resolveAirport, currency: 'EUR' };

		const snapshots = await drain(runSearch(BASE_QUERY, deps));
		const final = snapshots.at(-1)!;

		expect(final.itineraryGroups).toHaveLength(1);
		const group = final.itineraryGroups[0];
		expect(group.connectionAirportCode).toBe(FAST);
		expect(group.variants).toContain(group.best);

		expect(group.best.sources.outboundFlight.providerId).toBe('free-flights');
		expect(group.best.sources.onwardFlight.providerId).toBe('free-flights');
		expect(group.best.sources.stay?.providerId).toBe('stays');
		expect(group.best.sources.transferToHotel?.providerId).toBe('transit-fixture');
		expect(group.best.sources.transferToConnectionAirport?.providerId).toBe('transit-fixture');
	});
});

describe('runSearch: stay gender-fit filtering and candidate survival (issue #80)', () => {
	/** Returns a fixed female-dorm-plus-mixed-dorm pair for every stay query, regardless of
	 * `near` — these tests only care about the room-kind/price mix, not geography. */
	function fakeGenderMixStayProvider(): StayProvider {
		const stays: Stay[] = [
			{
				property: { name: 'Cheap Female Dorm', coordinates: { latitude: 48.2, longitude: 16.37 }, images: [] },
				roomKind: 'female-dorm',
				pricePerNight: { minorUnits: 1000, currency: 'EUR' }
			},
			{
				property: { name: 'Pricier Mixed Dorm', coordinates: { latitude: 48.2, longitude: 16.37 }, images: [] },
				roomKind: 'dorm',
				pricePerNight: { minorUnits: 2200, currency: 'EUR' }
			}
		];
		return {
			kind: 'stay',
			id: 'gender-mix-stays' as ProviderId, // fixture-only stand-in id, see source() above
			label: 'Fixture stays (gender mix)',
			needsKey: false,
			keyFields: [],
			async healthCheck() {
				return { ok: true, data: {}, source: source('gender-mix-stays'), requestsUsed: 0 };
			},
			estimateSearchStaysCost: () => 0,
			async searchStays(_query, ctx: ProviderContext): Promise<ProviderResult<Stay[]>> {
				if (ctx.signal.aborted) {
					return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: source('gender-mix-stays'), requestsUsed: 0 };
				}
				return { ok: true, data: stays, source: source('gender-mix-stays'), requestsUsed: 1 };
			}
		};
	}

	it('never lets a zero-female group\'s itinerary total rest on a female-only dorm, even though it is cheapest', async () => {
		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] },
			offerBuilder: standardOfferBuilder
		});
		const registry = new ProviderRegistry([free.provider, fakeGenderMixStayProvider(), createFakeTransferProvider()]);
		const deps: SearchDependencies = { registry, keys: {}, resolveAirport, currency: 'EUR' };
		const query: SearchQuery = { ...BASE_QUERY, travellers: 4, females: 0 };

		const snapshots = await drain(runSearch(query, deps));
		const final = snapshots.at(-1)!;

		const stayUsed = final.itineraryGroups[0]?.best.score.itinerary.stay;
		expect(stayUsed?.roomKind).not.toBe('female-dorm');
		expect(stayUsed?.property.name).toBe('Pricier Mixed Dorm');
	});

	it('keeps every stay found for a connection in the snapshot, not just the one picked', async () => {
		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] },
			offerBuilder: standardOfferBuilder
		});
		const registry = new ProviderRegistry([free.provider, fakeGenderMixStayProvider(), createFakeTransferProvider()]);
		const deps: SearchDependencies = { registry, keys: {}, resolveAirport, currency: 'EUR' };
		const query: SearchQuery = { ...BASE_QUERY, travellers: 4, females: 0 };

		const snapshots = await drain(runSearch(query, deps));
		const final = snapshots.at(-1)!;

		const candidatesForFast = final.stayCandidatesByConnection[FAST];
		expect(candidatesForFast).toBeDefined();
		expect(candidatesForFast.map((s) => s.property.name).sort()).toEqual(['Cheap Female Dorm', 'Pricier Mixed Dorm']);
	});

	it('still allows a female-only dorm as the pick when females is unspecified', async () => {
		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] },
			offerBuilder: standardOfferBuilder
		});
		const registry = new ProviderRegistry([free.provider, fakeGenderMixStayProvider(), createFakeTransferProvider()]);
		const deps: SearchDependencies = { registry, keys: {}, resolveAirport, currency: 'EUR' };
		// females omitted entirely — absent means "do not filter", not the same as 0.
		const query: SearchQuery = { ...BASE_QUERY, travellers: 4 };

		const snapshots = await drain(runSearch(query, deps));
		const final = snapshots.at(-1)!;

		const stayUsed = final.itineraryGroups[0]?.best.score.itinerary.stay;
		expect(stayUsed?.roomKind).toBe('female-dorm');
		expect(stayUsed?.property.name).toBe('Cheap Female Dorm');
	});
});

describe('widenSearch', () => {
	it('spends metered requests only for the targeted candidate, capped at the confirmed budget', async () => {
		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST, SLOW], [FAST]: [DEST], [SLOW]: [DEST] }
		});
		const metered = createFakeFlightProvider({
			id: 'metered-flights',
			needsKey: true,
			costPerQuery: 1,
			routes: {},
			offerBuilder: standardOfferBuilder
		});

		const registry = new ProviderRegistry([
			free.provider,
			metered.provider,
			createFakeStayProvider({ id: 'stays' }),
			createFakeTransferProvider()
		]);
		// A key IS configured this time — widenSearch is the caller's deliberate, priced
		// step, unlike runSearch which must never reach a keyed provider at all.
		const keys: AvailableKeys = { 'metered-flights': { apiKey: 'secret' } };
		const deps: SearchDependencies = { registry, keys, resolveAirport, currency: 'EUR' };

		const snapshots = await drain(
			widenSearch(
				BASE_QUERY,
				{
					targets: [{ candidateAirportCode: FAST, earliestDeparture: '2026-10-01', latestDeparture: '2026-10-01' }],
					maxMeteredRequests: 10
				},
				deps
			)
		);
		const final = snapshots.at(-1)!;

		expect(final.done).toBe(true);
		expect(final.candidates.map((c) => c.airportCode)).toEqual([FAST]); // SLOW was never a target
		expect(final.itineraryGroups.length).toBeGreaterThan(0);
		expect(metered.searchOffers).toHaveBeenCalled();
		expect(final.providers['metered-flights' as ProviderId]?.requestsUsed).toBeGreaterThan(0);
		expect(final.providers['metered-flights' as ProviderId]!.requestsUsed).toBeLessThanOrEqual(10);
	});

	it('never exceeds maxMeteredRequests even when a metered provider would otherwise be called for both legs', async () => {
		// A free provider still has to exist for route discovery — connections.ts's
		// ranking never spends a metered request even inside widenSearch (it recomputes
		// candidates itself); the metered provider under test here is only ever asked for
		// flight *offers*, gated by the budget below.
		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] }
		});
		const metered = createFakeFlightProvider({
			id: 'metered-flights',
			needsKey: true,
			costPerQuery: 1,
			routes: {}
		});
		const registry = new ProviderRegistry([
			free.provider,
			metered.provider,
			createFakeStayProvider({ id: 'stays' }),
			createFakeTransferProvider()
		]);
		const keys: AvailableKeys = { 'metered-flights': { apiKey: 'secret' } };
		const deps: SearchDependencies = { registry, keys, resolveAirport, currency: 'EUR' };

		// A budget of 0: the traveller has not confirmed spending anything yet.
		const snapshots = await drain(
			widenSearch(
				BASE_QUERY,
				{
					targets: [{ candidateAirportCode: FAST, earliestDeparture: '2026-10-01', latestDeparture: '2026-10-01' }],
					maxMeteredRequests: 0
				},
				deps
			)
		);

		expect(metered.searchOffers).not.toHaveBeenCalled();
		expect(snapshots.at(-1)!.providers['metered-flights' as ProviderId]?.requestsUsed ?? 0).toBe(0);
	});
});

/**
 * Mid-task finding: flight cost is three tiers, not two (docs/PROVIDERS.md, "Flights Sky has
 * a price calendar"). These tests use a `FlightsSkyProvider`-shaped fake — the real, merged
 * shape from issue #61 (`providers/flights/flights-sky.ts`:
 * `FlightsSkyProvider = FlightProvider & FlightPriceCalendarProvider`, `estimatePriceCalendarCost`
 * and `getPriceCalendar` flat on the provider, not nested) — to prove `runSearch`'s snapshot
 * distinguishes a cheap, broad "calendar" widen option from an expensive, narrow "confirm"
 * one, and that spending tier 2 for real (`widenWithPriceCalendar`) still never exceeds its
 * own confirmed budget.
 */
/** Confirm-tier ("Sky Scrapper") cost is one request PER DATE in the range — the real
 * behaviour docs/PROVIDERS.md measured, and the reason this tier is so much pricier than the
 * calendar's flat one-request-per-route. `createFakeFlightProvider`'s own `costPerQuery`
 * option is a flat constant, which would make the two tiers look identical, so this fixture
 * builds its own date-range-aware `estimateSearchOffersCost` instead. */
function enumerateDateCount(earliestDeparture: string, latestDeparture: string): number {
	const start = Date.parse(`${earliestDeparture}T00:00:00Z`);
	const end = Date.parse(`${latestDeparture}T00:00:00Z`);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
	return Math.round((end - start) / 86_400_000) + 1;
}

function calendarCapableMeteredProvider(id: string, costPerCalendarCall: number): FlightsSkyProvider {
	const base = createFakeFlightProvider({
		id,
		needsKey: true,
		routes: {},
		costPerQuery: (query) => enumerateDateCount(query.earliestDeparture, query.latestDeparture)
	}).provider;

	return {
		...base,
		estimatePriceCalendarCost: () => costPerCalendarCall,
		async getPriceCalendar(query: PriceCalendarQuery, ctx: ProviderContext) {
			const requestsUsed = ctx.maxRequests !== undefined ? Math.min(costPerCalendarCall, ctx.maxRequests) : costPerCalendarCall;
			if (requestsUsed < costPerCalendarCall) {
				return { ok: true as const, data: [], source: source(id), requestsUsed: 0 };
			}
			return {
				ok: true as const,
				data: [{ date: query.departDate, price: { minorUnits: 3300, currency: 'EUR' }, group: 'low' as const }],
				source: source(id),
				requestsUsed
			};
		}
	};
}

describe('runSearch: three-tier widen options', () => {
	it('lists a distinct cheap "calendar" option and an expensive "confirm" option for the same provider', async () => {
		const free = createFakeFlightProvider({
			id: 'free-flights',
			routes: { [ORIGIN]: [FAST], [FAST]: [DEST] },
			offerBuilder: standardOfferBuilder
		});
		// A ten-day departure window makes the "confirm" cost (one request per date) far
		// larger than the flat "calendar" cost (one request per route) — the whole point of
		// the mid-task finding.
		const wideQuery: SearchQuery = { ...BASE_QUERY, latestDeparture: '2026-10-10' };
		const calendarProvider = calendarCapableMeteredProvider('flights-sky', 1);

		const registry = new ProviderRegistry([
			free.provider,
			calendarProvider,
			createFakeStayProvider({ id: 'stays' }),
			createFakeTransferProvider()
		]);
		const deps: SearchDependencies = { registry, keys: {}, resolveAirport, currency: 'EUR' };

		const snapshots = await drain(runSearch(wideQuery, deps));
		const final = snapshots.at(-1)!;

		const forProvider = final.widenOptions.filter((o) => o.providerId === 'flights-sky');
		const calendarOption = forProvider.find((o) => o.tier === 'calendar');
		const confirmOption = forProvider.find((o) => o.tier === 'confirm');

		expect(calendarOption).toBeDefined();
		expect(confirmOption).toBeDefined();
		expect(calendarOption!.requests).toBeLessThan(confirmOption!.requests);
	});
});

describe('widenWithPriceCalendar', () => {
	it('spends tier 2 for real, streaming outcomes, never exceeding maxMeteredRequests', async () => {
		const calendarProvider = calendarCapableMeteredProvider('flights-sky', 1);
		const registry = new ProviderRegistry([calendarProvider]);
		const keys: AvailableKeys = { 'flights-sky': { apiKey: 'secret' } };
		const deps: SearchDependencies = { registry, keys, resolveAirport, currency: 'EUR' };

		const outcomes = [];
		for await (const outcome of widenWithPriceCalendar(
			BASE_QUERY,
			{ candidateAirportCodes: [FAST, SLOW], maxMeteredRequests: 3 },
			deps
		)) {
			outcomes.push(outcome);
		}

		// 2 candidates x 2 legs = 4 possible calls; the budget of 3 must cut it short.
		expect(outcomes.length).toBeLessThanOrEqual(3);
		const totalRequests = outcomes.reduce((sum, o) => sum + o.result.requestsUsed, 0);
		expect(totalRequests).toBeLessThanOrEqual(3);
	});

	it('never calls the calendar provider without a confirmed budget', async () => {
		const calendarProvider = calendarCapableMeteredProvider('flights-sky', 1);
		const spy = vi.spyOn(calendarProvider, 'getPriceCalendar');
		const registry = new ProviderRegistry([calendarProvider]);
		const keys: AvailableKeys = { 'flights-sky': { apiKey: 'secret' } };
		const deps: SearchDependencies = { registry, keys, resolveAirport, currency: 'EUR' };

		const outcomes = [];
		for await (const outcome of widenWithPriceCalendar(
			BASE_QUERY,
			{ candidateAirportCodes: [FAST], maxMeteredRequests: 0 },
			deps
		)) {
			outcomes.push(outcome);
		}

		expect(outcomes).toHaveLength(0);
		expect(spy).not.toHaveBeenCalled();
	});
});
