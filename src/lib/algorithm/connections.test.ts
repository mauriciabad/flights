import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MAX_CANDIDATES,
	ROUTE_PROBES_PER_KEPT_CANDIDATE,
	findConnectionCandidates,
	hasKnownDirectRoute,
	type ConnectionAirportInfo,
	type ConnectionQuery
} from './connections';
import { MAX_ROUTE_LOOKUPS_PER_SESSION } from '../providers/flights/kiwi-public';
import type { IataAirportCode } from '../domain';
import { MemoryCacheStore } from '../cache';
import type { FlightProvider, ProviderId, ProviderResult } from '../providers/types';
import { createRyanairFlightProvider } from '../providers/flights/ryanair';

/** Every `ConnectionQuery` needs a `soonestDeparture` (used only to build the probe query
 * `isFreeProvider` classifies a provider with — see connections.ts), never to actually
 * search anything, so a fixed placeholder date is fine across every test here. */
const SOONEST_DEPARTURE = '2026-10-01';

/**
 * A fake `FlightProvider` (matching `../providers/registry.test.ts`'s own convention) with
 * no network calls: `estimateSearchOffersCost` reports `metered ? 1 : 0`, which is exactly
 * the signal `connections.ts`'s `isFreeProvider` reads to decide whether this provider is
 * queried freely or held back as a last resort — no separate flag passed to
 * `findConnectionCandidates` at all. `listDirectDestinations` is `vi.fn`-wrapped so tests
 * can assert on call counts directly.
 */
function createFakeFlightProvider(
	id: string,
	opts: {
		routes?: Record<IataAirportCode, IataAirportCode[]>;
		metered?: boolean;
		fail?: boolean;
		/**
		 * Issue #340: what this provider knows that its `routes` sample does not show, as
		 * `origin -> destinations`. Present only when a test needs the two questions to
		 * disagree, which is the real shape of `kiwi-public`: its destination list is one
		 * row per city, price-sorted and capped, while a pair query answers exactly.
		 */
		pairs?: Record<IataAirportCode, IataAirportCode[]>;
	} = {}
): FlightProvider {
	const { routes = {}, metered = false, fail = false, pairs } = opts;
	const cost = metered ? 1 : 0;
	// Fixture-only stand-in id, not a real registered adapter — cast rather than widening
	// FlightProvider.id itself, which is exactly the closed `ProviderId` union issue #69
	// exists to enforce for real adapters.
	const providerId = id as ProviderId;
	const source = () => ({ providerId, fetchedAt: new Date().toISOString() });

	return {
		kind: 'flight',
		id: providerId,
		label: `Fake flights (${id})`,
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: { message: 'reachable' }, source: source(), requestsUsed: 0 };
		},
		estimateSearchOffersCost() {
			return cost;
		},
		async searchOffers() {
			return { ok: true, data: [], source: source(), requestsUsed: cost };
		},
		listDirectDestinations: vi.fn(
			async (iataCode: IataAirportCode): Promise<ProviderResult<IataAirportCode[]>> => {
				if (fail) {
					return {
						ok: false,
						error: { code: 'network-error', message: 'simulated failure' },
						source: source(),
						requestsUsed: cost
					};
				}
				return { ok: true, data: [...(routes[iataCode] ?? [])], source: source(), requestsUsed: cost };
			}
		),
		...(pairs
			? {
					hasDirectRoute: vi.fn(
						async (
							origin: IataAirportCode,
							destination: IataAirportCode
						): Promise<ProviderResult<boolean>> => {
							if (fail) {
								return {
									ok: false,
									error: { code: 'network-error', message: 'simulated failure' },
									source: source(),
									requestsUsed: cost
								};
							}
							return {
								ok: true,
								data: (pairs[origin] ?? []).includes(destination),
								source: source(),
								requestsUsed: cost
							};
						}
					)
				}
			: {})
	};
}

/**
 * A small, self-contained "real-ish" route graph modelled on an actual low-cost
 * short-haul network — Barcelona has no direct flight to Sofia, but Vienna and Milan
 * plausibly connect them (both roughly on the way), while Brussels does not (it's
 * northwest of Barcelona, the opposite direction from southeast-bound Sofia): exactly the
 * "technically reachable but two thousand kilometres backwards" case issue #12 names.
 *
 * Airport codes are fictional (Z-prefixed, confirmed absent from both the bundled
 * `connections-fallback-data.ts` table and the real airport dataset generated for issue
 * #11) rather than the real BCN/VIE/SOF/etc, even though the coordinates below are those
 * cities' real ones: `findConnectionCandidates` always unions in the bundled fallback
 * route table and always consults the real airport dataset for geography, and real IATA
 * codes would silently pick up extra edges or geography from those, making these tests
 * depend on data this file doesn't own. One test below (`falls back to the bundled route
 * table`) deliberately exercises that table using real codes instead.
 */
const ZBC = 'ZBC'; // stand-in for Barcelona (origin)
const ZSF = 'ZSF'; // stand-in for Sofia (destination)
const ZVI = 'ZVI'; // stand-in for Vienna
const ZMX = 'ZMX'; // stand-in for Milan Malpensa
const ZQB = 'ZQB'; // stand-in for Brussels Charleroi

const ROUTES: Record<IataAirportCode, IataAirportCode[]> = {
	[ZBC]: [ZVI, ZMX, ZQB],
	// Vienna's higher route count mirrors it being a genuine long-haul hub (Austrian
	// Airlines), unlike Milan Malpensa or Brussels Charleroi's shorter reach in this
	// fixture — connectivity should be able to tell those apart.
	[ZVI]: [ZBC, ZSF, 'JFK', 'DXB', 'HND', 'SYD', 'GRU', 'ORD'],
	[ZMX]: [ZBC, ZSF],
	[ZQB]: [ZBC, ZSF],
	[ZSF]: [ZVI, ZMX, ZQB]
};

const GEO: Record<IataAirportCode, ConnectionAirportInfo> = {
	[ZBC]: { coordinates: { latitude: 41.2971, longitude: 2.0785 }, sizeClass: 'large', countryCode: 'ES' },
	[ZSF]: { coordinates: { latitude: 42.6952, longitude: 23.4062 }, sizeClass: 'medium', countryCode: 'BG' },
	// Vienna: roughly on the great-circle line from Barcelona to Sofia (detour ratio ~1.23).
	[ZVI]: { coordinates: { latitude: 48.1103, longitude: 16.5697 }, sizeClass: 'large', countryCode: 'AT' },
	// Milan: an even smaller detour (~1.10) south of the direct line.
	[ZMX]: { coordinates: { latitude: 45.6306, longitude: 8.7281 }, sizeClass: 'large', countryCode: 'IT' },
	// Brussels: northwest of Barcelona, a real detour backwards for a Sofia-bound trip
	// (ratio ~1.54) — reachable, but not a good stopover.
	[ZQB]: { coordinates: { latitude: 50.4592, longitude: 4.4538 }, sizeClass: 'medium', countryCode: 'BE' }
};

function fixtureLookup(code: IataAirportCode): ConnectionAirportInfo | undefined {
	return GEO[code];
}

function fixtureProvider(id = 'fixture'): FlightProvider {
	return createFakeFlightProvider(id, { routes: ROUTES });
}

const QUERY: ConnectionQuery = {
	originAirport: ZBC,
	destinationAirport: ZSF,
	soonestDeparture: SOONEST_DEPARTURE
};

describe('the route-probe ceiling', () => {
	it('leaves the free sources a lookup for the origin', () => {
		// The ceiling counts candidate probes; a search also spends one on the origin. Both
		// come out of `kiwi-public.ts`'s per-session budget, and a search that runs past it
		// makes the reload ask about airports the first load never reached, which is issue
		// #194 and what `route-graph-fanout.qa.ts` fails on. Raising either number without
		// the other is the mistake this guards.
		expect(DEFAULT_MAX_CANDIDATES * ROUTE_PROBES_PER_KEPT_CANDIDATE).toBeLessThan(
			MAX_ROUTE_LOOKUPS_PER_SESSION
		);
	});
});

describe('findConnectionCandidates', () => {
	it('never makes a network call: the fake provider is the only thing invoked', async () => {
		const provider = fixtureProvider();
		await findConnectionCandidates(QUERY, {
			flightProviders: [provider],
			airportLookup: fixtureLookup
		});
		expect(provider.listDirectDestinations).toHaveBeenCalled();
	});

	it('classifies a provider by estimateSearchOffersCost, not an out-of-band flag: a cost-0 provider is queried directly, with no allow-list needed', async () => {
		const provider = fixtureProvider();
		expect(
			provider.estimateSearchOffersCost({
				origin: ZBC,
				destination: ZSF,
				earliestDeparture: SOONEST_DEPARTURE,
				latestDeparture: SOONEST_DEPARTURE
			})
		).toBe(0);
		const candidates = await findConnectionCandidates(QUERY, {
			flightProviders: [provider],
			airportLookup: fixtureLookup
		});
		expect(candidates.length).toBeGreaterThan(0);
	});

	it('produces a plausible ranked list for a route with no direct flight', async () => {
		const candidates = await findConnectionCandidates(QUERY, {
			flightProviders: [fixtureProvider()],
			airportLookup: fixtureLookup
		});

		const codes = candidates.map((c) => c.airportCode);
		expect(codes).toContain(ZVI);
		expect(codes).toContain(ZMX);

		// Brussels is a real detour backwards, not a plausible stopover between Barcelona
		// and Sofia, so it must not outrank the two sane candidates even if it appears.
		const viRank = codes.indexOf(ZVI);
		const mxRank = codes.indexOf(ZMX);
		const qbRank = codes.indexOf(ZQB);
		if (qbRank !== -1) {
			expect(qbRank).toBeGreaterThan(viRank);
			expect(qbRank).toBeGreaterThan(mxRank);
		}
	});

	it('excludes a candidate whose detour ratio exceeds maxDetourRatio', async () => {
		const candidates = await findConnectionCandidates(QUERY, {
			flightProviders: [fixtureProvider()],
			airportLookup: fixtureLookup,
			maxDetourRatio: 1.3 // Brussels' ~1.54 ratio is above this; Vienna's ~1.23 and Milan's ~1.10 are not.
		});
		expect(candidates.map((c) => c.airportCode)).not.toContain(ZQB);
	});

	it('never returns a forbidden country, even when that country hosts the best-connected candidate', async () => {
		const candidates = await findConnectionCandidates(
			{ ...QUERY, forbiddenConnectionCountries: ['AT'] },
			{ flightProviders: [fixtureProvider()], airportLookup: fixtureLookup }
		);
		expect(candidates.every((c) => c.airportCode !== ZVI)).toBe(true);
	});

	it('never returns a forbidden airport by code', async () => {
		const candidates = await findConnectionCandidates(
			{ ...QUERY, forbiddenConnectionAirports: [ZMX] },
			{ flightProviders: [fixtureProvider()], airportLookup: fixtureLookup }
		);
		expect(candidates.some((c) => c.airportCode === ZMX)).toBe(false);
	});

	it('drops a candidate whose country cannot be determined once a forbidden-country list is given', async () => {
		// 'ZZZ' is this codebase's own convention for "guaranteed absent from the real
		// airport dataset" (see src/lib/data/airports.test.ts), and it isn't in
		// `fixtureLookup` either, so every geography tier comes back empty for it.
		const provider = createFakeFlightProvider('fixture-with-unknown', {
			routes: { [ZBC]: ['ZZZ'], ZZZ: [ZSF] }
		});
		const candidates = await findConnectionCandidates(
			{ ...QUERY, forbiddenConnectionCountries: ['AT'] },
			{ flightProviders: [provider], airportLookup: fixtureLookup }
		);
		expect(candidates.some((c) => c.airportCode === 'ZZZ')).toBe(false);
	});

	it('drops an unresolvable code unconditionally and never queries it (issue #89: metropolitan codes)', async () => {
		// 'ZZZ' stands in here for an IATA *metropolitan* code (ROM, PAR, MIL, ...): a
		// real route-graph source can list it as if it were a destination, but no
		// geography tier resolves it because it isn't a single real airport. Unlike the
		// forbidden-country test above, this must be dropped even with no forbidden list
		// in effect at all — the point of issue #89's fix is that a code like this is
		// never usable, not just risky.
		const provider = createFakeFlightProvider('fixture-with-metro-code', {
			routes: { [ZBC]: [ZVI, 'ZZZ'], [ZVI]: [ZSF], ZZZ: [ZSF] }
		});
		const candidates = await findConnectionCandidates(QUERY, {
			flightProviders: [provider],
			airportLookup: fixtureLookup
		});

		expect(candidates.some((c) => c.airportCode === 'ZZZ')).toBe(false);

		// The measured bug (issue #89): 13 failing requests, one per unresolvable
		// candidate, each probing "what does this code itself fly to". Proving 'ZZZ'
		// is never passed to listDirectDestinations is proving that request never fires.
		const queriedCodes = vi.mocked(provider.listDirectDestinations).mock.calls.map((call) => call[0]);
		expect(queriedCodes).not.toContain('ZZZ');
		expect(queriedCodes).toContain(ZVI); // sanity: a real candidate is still queried
	});

	it('respects an explicit allow-list, excluding an otherwise-valid candidate not on it', async () => {
		const candidates = await findConnectionCandidates(
			{ ...QUERY, allowedConnectionAirports: [ZVI] },
			{ flightProviders: [fixtureProvider()], airportLookup: fixtureLookup }
		);
		expect(candidates.map((c) => c.airportCode)).toEqual([ZVI]);
	});

	it('respects the configurable cap, keeping only the highest-scoring candidates', async () => {
		const candidates = await findConnectionCandidates(QUERY, {
			flightProviders: [fixtureProvider()],
			airportLookup: fixtureLookup,
			maxCandidates: 1
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.airportCode).toBe(ZVI);
	});

	it('reports the confirmed candidates the cap dropped, rather than forgetting them (issue #350)', async () => {
		// The cap stays exactly where it is — each candidate kept costs two metered fare
		// searches downstream. What changes is that the caller can now tell "we found one" from
		// "we found several and are pricing one", which nothing on screen could distinguish.
		const beyondCap: IataAirportCode[][] = [];
		const candidates = await findConnectionCandidates(QUERY, {
			flightProviders: [fixtureProvider()],
			airportLookup: fixtureLookup,
			maxCandidates: 1,
			onCandidatesBeyondCap: (dropped) => beyondCap.push(dropped.map((c) => c.airportCode))
		});

		expect(beyondCap).toHaveLength(1);
		expect(beyondCap[0]).toContain(ZMX);
		expect(beyondCap[0]).not.toContain(candidates[0]!.airportCode);
		// Confirmed on both legs, exactly like the one that was kept — the difference between
		// them is the cap and nothing else.
		expect(beyondCap[0]!.length).toBeGreaterThan(0);
	});

	it('says nothing when the cap never filled', async () => {
		const beyondCap: unknown[] = [];
		await findConnectionCandidates(QUERY, {
			flightProviders: [fixtureProvider()],
			airportLookup: fixtureLookup,
			maxCandidates: 99,
			onCandidatesBeyondCap: (dropped) => beyondCap.push(dropped)
		});
		expect(beyondCap).toEqual([]);
	});

	it('defaults the cap to DEFAULT_MAX_CANDIDATES', async () => {
		expect(DEFAULT_MAX_CANDIDATES).toBeGreaterThan(0);
		const candidates = await findConnectionCandidates(QUERY, {
			flightProviders: [fixtureProvider()],
			airportLookup: fixtureLookup
		});
		expect(candidates.length).toBeLessThanOrEqual(DEFAULT_MAX_CANDIDATES);
	});

	it('returns no candidates, and calls no provider, when origin equals destination', async () => {
		const provider = fixtureProvider();
		const candidates = await findConnectionCandidates(
			{ originAirport: ZBC, destinationAirport: ZBC, soonestDeparture: SOONEST_DEPARTURE },
			{ flightProviders: [provider], airportLookup: fixtureLookup }
		);
		expect(candidates).toEqual([]);
		expect(provider.listDirectDestinations).not.toHaveBeenCalled();
	});

	it('falls through to the bundled fallback table when a free provider returns {ok: false}, rather than failing the search', async () => {
		const flaky = createFakeFlightProvider('flaky', { fail: true }); // free (cost 0), always errors
		// Real BCN -> SOF: no direct route, but the bundled table connects both through
		// Vienna — this must still work even though the only configured provider always
		// fails.
		const candidates = await findConnectionCandidates(
			{ originAirport: 'BCN', destinationAirport: 'SOF', soonestDeparture: SOONEST_DEPARTURE },
			{ flightProviders: [flaky] }
		);
		expect(candidates.some((c) => c.airportCode === 'VIE')).toBe(true);
		expect(flaky.listDirectDestinations).toHaveBeenCalled();
	});

	it('never spends a metered request when every provider is free, even with an unconfirmable candidate', async () => {
		const sparse = createFakeFlightProvider('sparse', { routes: { [ZBC]: [ZVI] } });
		const candidates = await findConnectionCandidates(
			{ ...QUERY, allowedConnectionAirports: [ZVI] },
			{ flightProviders: [sparse], airportLookup: fixtureLookup }
		);
		// ZVI -> ZSF isn't confirmed by `sparse`, and there is no metered provider to
		// fall back to, so it's correctly dropped rather than guessed at.
		expect(candidates).toEqual([]);
	});

	it('spends exactly one metered request to confirm an allow-listed candidate free providers could not, and stays under budget', async () => {
		const sparse = createFakeFlightProvider('sparse', { routes: { [ZBC]: [ZVI] } });
		const metered = createFakeFlightProvider('metered-aggregator', {
			routes: { [ZVI]: [ZSF] },
			metered: true
		});
		const candidates = await findConnectionCandidates(
			{ ...QUERY, allowedConnectionAirports: [ZVI] },
			{
				flightProviders: [sparse, metered],
				airportLookup: fixtureLookup,
				meteredRequestBudget: 5
			}
		);
		expect(candidates.map((c) => c.airportCode)).toEqual([ZVI]);
		expect(candidates[0]!.meteredRequestSpent).toBe(true);
		expect(candidates[0]!.confirmedBy.inbound).toBe('metered-aggregator');
		expect(metered.listDirectDestinations).toHaveBeenCalledTimes(1);
	});

	it("a metered provider's {ok: false} doesn't throw and is treated as unconfirmed", async () => {
		const sparse = createFakeFlightProvider('sparse', { routes: { [ZBC]: [ZVI] } });
		const failingMetered = createFakeFlightProvider('flaky-metered', { metered: true, fail: true });
		const candidates = await findConnectionCandidates(
			{ ...QUERY, allowedConnectionAirports: [ZVI] },
			{
				flightProviders: [sparse, failingMetered],
				airportLookup: fixtureLookup,
				meteredRequestBudget: 5
			}
		);
		expect(candidates).toEqual([]);
		expect(failingMetered.listDirectDestinations).toHaveBeenCalledTimes(1);
	});

	it('never exceeds meteredRequestBudget even with several allow-listed candidates needing confirmation', async () => {
		const sparse = createFakeFlightProvider('sparse', { routes: { [ZBC]: [ZVI, ZMX, ZQB] } });
		const metered = createFakeFlightProvider('metered-aggregator', {
			routes: { [ZVI]: [ZSF], [ZMX]: [ZSF], [ZQB]: [ZSF] },
			metered: true
		});
		const candidates = await findConnectionCandidates(
			{ ...QUERY, allowedConnectionAirports: [ZVI, ZMX, ZQB] },
			{
				flightProviders: [sparse, metered],
				airportLookup: fixtureLookup,
				meteredRequestBudget: 1 // Only enough for one of the three.
			}
		);
		expect(metered.listDirectDestinations).toHaveBeenCalledTimes(1);
		expect(candidates.length).toBe(1);
	});

	it('never spends a metered request just for broad (non-allow-listed) discovery', async () => {
		const sparse = createFakeFlightProvider('sparse', { routes: { [ZBC]: [ZVI, ZMX, ZQB] } });
		const metered = createFakeFlightProvider('metered-aggregator', {
			routes: { [ZVI]: [ZSF], [ZMX]: [ZSF], [ZQB]: [ZSF] },
			metered: true
		});
		await findConnectionCandidates(QUERY, {
			flightProviders: [sparse, metered],
			airportLookup: fixtureLookup,
			meteredRequestBudget: 10
		});
		expect(metered.listDirectDestinations).not.toHaveBeenCalled();
	});

	it('offers Bergamo, which a one-row-per-city source hides behind Malpensa (issue #340)', async () => {
		// The owner's own report, in miniature and with the real codes. Kiwi answers "which
		// airports does Boa Vista fly to" with one itinerary per destination CITY, so Milan
		// comes back as Malpensa alone and Bergamo is not in the list at all — while Kiwi
		// will sell you Neos NO3865 BVC to BGY on 7 October 2026 for EUR 262, and Ryanair
		// flies BGY to Pafos for EUR 63. The app offered London Gatwick, fifth-fastest of the
		// ten flightconnections.com lists, and not Bergamo, second at 9h 40.
		//
		// `routes` is what the sampled list says. `pairs` is what the provider actually
		// knows. The gap between them is the bug.
		const provider = createFakeFlightProvider('one-per-city', {
			routes: { BVC: ['MXP'], MXP: [] },
			pairs: { BVC: ['MXP', 'BGY'], BGY: ['PFO'] }
		});

		const candidates = await findConnectionCandidates(
			{ originAirport: 'BVC', destinationAirport: 'PFO', soonestDeparture: SOONEST_DEPARTURE },
			{ flightProviders: [provider] }
		);

		expect(candidates.map((c) => c.airportCode)).toContain('BGY');
	});

	it('does not offer a sibling airport the origin has no flight to (issue #340)', async () => {
		// The other half of the same change: Milan's third airport reaches Pafos in the
		// bundled snapshot exactly as Bergamo does, so proposing it costs nothing and is
		// right. Offering it would be an invention — nothing flies Boa Vista to Linate, and
		// the pair query is what settles that before the fare stage is ever asked.
		const provider = createFakeFlightProvider('one-per-city', {
			routes: { BVC: ['MXP'], MXP: [] },
			pairs: { BVC: ['MXP', 'BGY'], BGY: ['PFO'], LIN: ['PFO'] }
		});

		const candidates = await findConnectionCandidates(
			{ originAirport: 'BVC', destinationAirport: 'PFO', soonestDeparture: SOONEST_DEPARTURE },
			{ flightProviders: [provider] }
		);

		expect(candidates.map((c) => c.airportCode)).not.toContain('LIN');
	});

	it('confirms an onward leg the destination list samples away (issue #340)', async () => {
		// The same defect on the far side, and the one that cost four of the ten. Paphos is
		// in none of Munich's, Orly's, Amsterdam's, Brussels' or Fiumicino's destination
		// lists, because those are price-sorted samples of a hub's network rather than the
		// network — and Kiwi sells every one of those pairs. Membership in a sample was
		// standing in for "does this airport fly there".
		const provider = createFakeFlightProvider('sampled-hub', {
			routes: { BVC: ['MUC'], MUC: ['LIS', 'OPO'] },
			pairs: { BVC: ['MUC'], MUC: ['PFO'] }
		});

		const candidates = await findConnectionCandidates(
			{ originAirport: 'BVC', destinationAirport: 'PFO', soonestDeparture: SOONEST_DEPARTURE },
			{ flightProviders: [provider] }
		);

		expect(candidates.map((c) => c.airportCode)).toEqual(['MUC']);
	});

	it('lets one source answering exactly stand in for none of the others (issue #340)', async () => {
		// A per-group fallback would have made adding `hasDirectRoute` to one adapter delete
		// every candidate the adapters without it had vouched for. Measured the hard way:
		// wiring the build-time cheap-routes wrapper up first took 21 pipeline tests down
		// with it, because it answered "not me" for fixtures it has never heard of and the
		// providers holding the data were then never asked at all.
		const exact = createFakeFlightProvider('answers-pairs', { routes: {}, pairs: { XXX: [] } });
		const listOnly = createFakeFlightProvider('answers-lists', {
			routes: { BCN: ['VIE'], VIE: ['SOF'] }
		});

		const candidates = await findConnectionCandidates(
			{ originAirport: 'BCN', destinationAirport: 'SOF', soonestDeparture: SOONEST_DEPARTURE },
			{ flightProviders: [exact, listOnly] }
		);

		expect(candidates.map((c) => c.airportCode)).toContain('VIE');
	});

	it('still asks the bundled route graph about a candidate it has no request budget left for (issue #255)', async () => {
		// The regression that lost half of docs/ACCEPTANCE.md's route, in miniature. Real
		// codes and real geography, because both are the point: for BVC to PFO the two
		// airports that actually fly on to Pafos are the two the geographic ranking puts
		// last, so a ceiling applied to that ranking cuts exactly them.
		//
		// `maxRouteProbes: 1` rather than the shipped default. A test pinned to the default
		// can only fail when someone lowers it, and the defect was never about the value:
		// Birmingham and Manchester came 20th and 21st, and no value a hub can live with is
		// that generous. What has to hold at every ceiling is that running out of request
		// budget stops the search spending, not the search looking.
		//
		// The provider is the only thing that can answer for Amsterdam. Birmingham and
		// Manchester are in the bundled Ryanair snapshot as flying to Pafos, so they are
		// answerable without it, and that is the whole difference between them.
		const provider = createFakeFlightProvider('beyond-budget', {
			routes: { BVC: ['FCO', 'AMS', 'BHX', 'MAN'], FCO: ['PFO'], AMS: ['PFO'] }
		});

		const candidates = await findConnectionCandidates(
			{ originAirport: 'BVC', destinationAirport: 'PFO', soonestDeparture: SOONEST_DEPARTURE },
			{ flightProviders: [provider], maxRouteProbes: 1 }
		);
		const found = candidates.map((c) => c.airportCode);

		expect(found).toContain('BHX');
		expect(found).toContain('MAN');
		expect(found).not.toContain('AMS');
		// Once, for the origin, and for no candidate at all. Was twice until issue #340:
		// the one candidate inside the request budget is Rome, and Rome is in the bundled
		// snapshot as flying to Pafos, so the question is settled before a request is built
		// for it. Past the ceiling nothing is spent, which is what #255 is about, and inside
		// it nothing is spent either when the answer already ships with the app.
		expect(provider.listDirectDestinations).toHaveBeenCalledTimes(1);
	});

	it('falls back to the bundled route table when no flightProviders are supplied at all', async () => {
		// Real BCN -> SOF: no direct route in the bundled fallback table either, but VIE
		// connects to both, exercising "offline and first paint both work" with zero
		// configuration.
		const candidates = await findConnectionCandidates({
			originAirport: 'BCN',
			destinationAirport: 'SOF',
			soonestDeparture: SOONEST_DEPARTURE
		});
		expect(candidates.some((c) => c.airportCode === 'VIE')).toBe(true);
		expect(candidates.every((c) => c.confirmedBy.outbound === 'fallback-table')).toBe(true);
	});

	it('uses real-world geography from the airport dataset (issue #11) when no airportLookup override is given', async () => {
		// Real BCN -> SOF via the bundled route table, but with no fixture geography at
		// all: ranking must still work off the real airport dataset's coordinates and
		// size class rather than silently degrading.
		const candidates = await findConnectionCandidates({
			originAirport: 'BCN',
			destinationAirport: 'SOF',
			soonestDeparture: SOONEST_DEPARTURE
		});
		const vie = candidates.find((c) => c.airportCode === 'VIE');
		expect(vie?.breakdown.detour).not.toBeNull();
	});

	it('interoperates with the real Ryanair FlightProvider adapter (issue #6): classified free from estimateSearchOffersCost and actually queried', async () => {
		// Same fixture-`fetch` pattern `../providers/flights/ryanair.test.ts` itself uses:
		// no real network call, no real IndexedDB — just this adapter's own public
		// test-injection points (`store`, `fetchImpl`).
		//
		// A purpose-built three-airport network rather than the shared active-airports
		// fixture, because this test needs a BCN -> AHO -> AGP path and that fixture has
		// no AGP. Real shape: since issue #121 the adapter reads its whole route graph off
		// this one endpoint's `routes` arrays, so a stub has to speak that encoding.
		const requestedUrls: string[] = [];
		const activeAirports = [
			{ iataCode: 'BCN', timeZone: 'Europe/Madrid', routes: ['airport:AHO', 'city:ALGHERO'] },
			{ iataCode: 'AHO', timeZone: 'Europe/Rome', routes: ['airport:AGP', 'airport:BCN'] },
			{ iataCode: 'AGP', timeZone: 'Europe/Madrid', routes: ['airport:AHO'] }
		];
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = input.toString();
			requestedUrls.push(url);
			if (url === 'https://www.ryanair.com/api/views/locate/3/airports/en/active') {
				return new Response(JSON.stringify(activeAirports), { status: 200 });
			}
			throw new Error(`no fixture stubbed for ${url}`);
		}) as typeof fetch;

		const ryanair = createRyanairFlightProvider({ store: new MemoryCacheStore(), fetchImpl });

		// No meteredRequestBudget at all (defaults to 0). If Ryanair's cost-0
		// `estimateSearchOffersCost` were somehow not enough to classify it as free, it
		// would never be queried under a zero budget and this would return nothing.
		const candidates = await findConnectionCandidates(
			{ originAirport: 'BCN', destinationAirport: 'AGP', soonestDeparture: SOONEST_DEPARTURE },
			{ flightProviders: [ryanair] }
		);

		expect(
			candidates.some((c) => c.confirmedBy.outbound === 'ryanair' || c.confirmedBy.inbound === 'ryanair')
		).toBe(true);
		// Issue #121: the adapter is asked about every candidate airport, but it spends one
		// request for the whole graph rather than one per airport.
		expect(requestedUrls).toEqual(['https://www.ryanair.com/api/views/locate/3/airports/en/active']);
	});
});

describe('hasKnownDirectRoute', () => {
	it('is true when a free source lists a direct A -> B edge', async () => {
		const provider = createFakeFlightProvider('direct-route', { routes: { [ZBC]: [ZSF] } });
		await expect(
			hasKnownDirectRoute(
				{ originAirport: ZBC, destinationAirport: ZSF, soonestDeparture: SOONEST_DEPARTURE },
				{ flightProviders: [provider] }
			)
		).resolves.toBe(true);
	});

	it('is false when no free source lists a direct edge, never a guess from stopover reachability', async () => {
		// Same ROUTES fixture `findConnectionCandidates`'s own tests use: ZBC has no direct
		// edge to ZSF here, only edges to candidates that themselves connect onward to ZSF.
		const provider = fixtureProvider();
		await expect(
			hasKnownDirectRoute(
				{ originAirport: ZBC, destinationAirport: ZSF, soonestDeparture: SOONEST_DEPARTURE },
				{ flightProviders: [provider] }
			)
		).resolves.toBe(false);
	});

	it('is false, not a throw, for a caller who passes no flightProviders at all (the bundled fallback table still runs)', async () => {
		await expect(
			hasKnownDirectRoute({ originAirport: ZBC, destinationAirport: ZSF, soonestDeparture: SOONEST_DEPARTURE })
		).resolves.toBe(false);
	});

	it('is false for querying an airport against itself, the same "not a real question" guard findConnectionCandidates uses', async () => {
		const provider = createFakeFlightProvider('self-loop', { routes: { [ZBC]: [ZBC] } });
		await expect(
			hasKnownDirectRoute(
				{ originAirport: ZBC, destinationAirport: ZBC, soonestDeparture: SOONEST_DEPARTURE },
				{ flightProviders: [provider] }
			)
		).resolves.toBe(false);
	});

	it('never spends a metered request: a metered provider is excluded from the free-source union entirely', async () => {
		const metered = createFakeFlightProvider('metered-direct', { routes: { [ZBC]: [ZSF] }, metered: true });
		await expect(
			hasKnownDirectRoute(
				{ originAirport: ZBC, destinationAirport: ZSF, soonestDeparture: SOONEST_DEPARTURE },
				{ flightProviders: [metered] }
			)
		).resolves.toBe(false);
		expect(metered.listDirectDestinations).not.toHaveBeenCalled();
	});

	it("widens a free source's city-level code to any of its member airports (issue #107's own BCN -> CDG example)", async () => {
		// Mirrors how Travelpayouts' own cheap-routes dataset actually reports a Paris
		// fare live: as "PAR", never the specific airport (CDG/ORY/BVA) it flew into.
		// Verified live against a real search before this test existed: without the
		// metro-code widening, this exact query came back `false`.
		const provider = createFakeFlightProvider('cheap-routes-fixture', { routes: { BCN: ['PAR'] } });
		await expect(
			hasKnownDirectRoute(
				{ originAirport: 'BCN', destinationAirport: 'CDG', soonestDeparture: SOONEST_DEPARTURE },
				{ flightProviders: [provider] }
			)
		).resolves.toBe(true);
	});

	it('does not widen for a destination outside every known metro-code grouping', async () => {
		const provider = createFakeFlightProvider('cheap-routes-fixture', { routes: { BCN: ['PAR'] } });
		await expect(
			hasKnownDirectRoute(
				{ originAirport: 'BCN', destinationAirport: 'AGP', soonestDeparture: SOONEST_DEPARTURE },
				{ flightProviders: [provider] }
			)
		).resolves.toBe(false);
	});
});

describe('onProviderResult (issue #130)', () => {
	it("reports a provider's empty answer, which the route graph itself discards", async () => {
		// The BVC shape: an airport outside this provider's network. Ryanair's adapter turns
		// its own 404 into exactly this ok-and-empty result, and `sourceFromProvider` folds it
		// into "no edges", so without this hook a caller never learned a real request had been
		// made and answered.
		const provider = createFakeFlightProvider('empty-network-fixture', { routes: {} });
		const seen: { id: string; ok: boolean; rows: number }[] = [];

		await findConnectionCandidates(QUERY, {
			flightProviders: [provider],
			airportLookup: fixtureLookup,
			onProviderResult: (called, result) => {
				seen.push({ id: called.id, ok: result.ok, rows: result.ok ? result.data.length : -1 });
			}
		});

		expect(seen).toEqual([{ id: 'empty-network-fixture', ok: true, rows: 0 }]);
	});

	it('reports a failure as a failure, not as an empty answer', async () => {
		const provider = createFakeFlightProvider('failing-fixture', { fail: true });
		const seen: boolean[] = [];

		await findConnectionCandidates(QUERY, {
			flightProviders: [provider],
			airportLookup: fixtureLookup,
			onProviderResult: (_provider, result) => seen.push(result.ok)
		});

		expect(seen).toEqual([false]);
	});

	it('reports one result per airport the graph asks about', async () => {
		const provider = fixtureProvider();
		const outcomes: string[] = [];

		await findConnectionCandidates(QUERY, {
			flightProviders: [provider],
			airportLookup: fixtureLookup,
			onProviderResult: (_provider, result) => outcomes.push(result.ok ? 'ok' : 'failed')
		});

		// The origin, then each surviving candidate's own inbound lookup.
		expect(outcomes.length).toBeGreaterThan(1);
		expect(outcomes.every((entry) => entry === 'ok')).toBe(true);
	});

	it('reports from hasKnownDirectRoute too, so an empty-results screen can name its sources', async () => {
		const provider = createFakeFlightProvider('empty-network-fixture', { routes: {} });
		const seen: string[] = [];

		await hasKnownDirectRoute(
			{ originAirport: ZBC, destinationAirport: ZSF, soonestDeparture: SOONEST_DEPARTURE },
			{ flightProviders: [provider], onProviderResult: (called) => seen.push(called.id) }
		);

		expect(seen).toEqual(['empty-network-fixture']);
	});
});
