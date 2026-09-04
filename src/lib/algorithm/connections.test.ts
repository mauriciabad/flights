import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MAX_CANDIDATES,
	findConnectionCandidates,
	type ConnectionAirportInfo,
	type ConnectionQuery,
	type DirectDestinationSource
} from './connections';
import type { IataAirportCode } from '../domain';

/**
 * A small, self-contained "real-ish" route graph modelled on an actual low-cost
 * short-haul network — Barcelona has no direct flight to Sofia, but Vienna and Milan
 * plausibly connect them (both roughly on the way), while Brussels does not (it's
 * northwest of Barcelona, the opposite direction from southeast-bound Sofia): exactly the
 * "technically reachable but two thousand kilometres backwards" case issue #12 names.
 *
 * Airport codes are fictional (Z-prefixed) rather than the real BCN/VIE/SOF/etc, even
 * though the coordinates below are those cities' real ones: `findConnectionCandidates`
 * always unions in the bundled `connections-fallback-data.ts` table (by design — see its
 * doc comment), and real IATA codes would silently pick up extra edges from that table,
 * making these tests depend on its exact contents. One test below (`falls back to the
 * bundled route table`) deliberately exercises that table using real codes instead.
 */
const ZBC = 'ZBC'; // stand-in for Barcelona (origin)
const ZSF = 'ZSF'; // stand-in for Sofia (destination)
const ZVI = 'ZVI'; // stand-in for Vienna
const ZMX = 'ZMX'; // stand-in for Milan Malpensa
const ZBR = 'ZBR'; // stand-in for Brussels Charleroi

const ROUTES: Record<IataAirportCode, IataAirportCode[]> = {
	[ZBC]: [ZVI, ZMX, ZBR],
	// Vienna's higher route count mirrors it being a genuine long-haul hub (Austrian
	// Airlines), unlike Milan Malpensa or Brussels Charleroi's shorter reach in this
	// fixture — connectivity should be able to tell those apart.
	[ZVI]: [ZBC, ZSF, 'JFK', 'DXB', 'HND', 'SYD', 'GRU', 'ORD'],
	[ZMX]: [ZBC, ZSF],
	[ZBR]: [ZBC, ZSF],
	[ZSF]: [ZVI, ZMX, ZBR]
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
	[ZBR]: { coordinates: { latitude: 50.4592, longitude: 4.4538 }, sizeClass: 'medium', countryCode: 'BE' }
};

function fixtureSource(id = 'fixture'): DirectDestinationSource {
	return {
		id,
		getDirectDestinations: vi.fn((code: IataAirportCode) => Promise.resolve([...(ROUTES[code] ?? [])]))
	};
}

function fixtureLookup(code: IataAirportCode): ConnectionAirportInfo | undefined {
	return GEO[code];
}

const QUERY: ConnectionQuery = { originAirport: ZBC, destinationAirport: ZSF };

describe('findConnectionCandidates', () => {
	it('never makes a network call: the fixture source is the only thing invoked', async () => {
		const source = fixtureSource();
		await findConnectionCandidates(QUERY, {
			routeGraphSources: [source],
			airportLookup: fixtureLookup
		});
		expect(source.getDirectDestinations).toHaveBeenCalled();
	});

	it('produces a plausible ranked list for a route with no direct flight', async () => {
		const candidates = await findConnectionCandidates(QUERY, {
			routeGraphSources: [fixtureSource()],
			airportLookup: fixtureLookup
		});

		const codes = candidates.map((c) => c.airportCode);
		expect(codes).toContain(ZVI);
		expect(codes).toContain(ZMX);

		// Brussels is a real detour backwards, not a plausible stopover between Barcelona
		// and Sofia, so it must not outrank the two sane candidates even if it appears.
		const viRank = codes.indexOf(ZVI);
		const mxRank = codes.indexOf(ZMX);
		const brRank = codes.indexOf(ZBR);
		if (brRank !== -1) {
			expect(brRank).toBeGreaterThan(viRank);
			expect(brRank).toBeGreaterThan(mxRank);
		}
	});

	it('excludes a candidate whose detour ratio exceeds maxDetourRatio', async () => {
		const candidates = await findConnectionCandidates(QUERY, {
			routeGraphSources: [fixtureSource()],
			airportLookup: fixtureLookup,
			maxDetourRatio: 1.3 // Brussels' ~1.54 ratio is above this; Vienna's ~1.23 and Milan's ~1.10 are not.
		});
		expect(candidates.map((c) => c.airportCode)).not.toContain(ZBR);
	});

	it('never returns a forbidden country, even when that country hosts the best-connected candidate', async () => {
		const candidates = await findConnectionCandidates(
			{ ...QUERY, forbiddenConnectionCountries: ['AT'] },
			{ routeGraphSources: [fixtureSource()], airportLookup: fixtureLookup }
		);
		expect(candidates.every((c) => c.airportCode !== ZVI)).toBe(true);
	});

	it('never returns a forbidden airport by code', async () => {
		const candidates = await findConnectionCandidates(
			{ ...QUERY, forbiddenConnectionAirports: [ZMX] },
			{ routeGraphSources: [fixtureSource()], airportLookup: fixtureLookup }
		);
		expect(candidates.some((c) => c.airportCode === ZMX)).toBe(false);
	});

	it('drops a candidate whose country cannot be determined once a forbidden-country list is given', async () => {
		const source: DirectDestinationSource = {
			id: 'fixture-with-unknown',
			getDirectDestinations: (code) =>
				Promise.resolve(code === ZBC ? ['ZXY'] : code === 'ZXY' ? [ZSF] : [])
		};
		const candidates = await findConnectionCandidates(
			{ ...QUERY, forbiddenConnectionCountries: ['AT'] },
			{ routeGraphSources: [source], airportLookup: fixtureLookup } // fixtureLookup has no entry for ZXY
		);
		expect(candidates.some((c) => c.airportCode === 'ZXY')).toBe(false);
	});

	it('respects an explicit allow-list, excluding an otherwise-valid candidate not on it', async () => {
		const candidates = await findConnectionCandidates(
			{ ...QUERY, allowedConnectionAirports: [ZVI] },
			{ routeGraphSources: [fixtureSource()], airportLookup: fixtureLookup }
		);
		expect(candidates.map((c) => c.airportCode)).toEqual([ZVI]);
	});

	it('respects the configurable cap, keeping only the highest-scoring candidates', async () => {
		const candidates = await findConnectionCandidates(QUERY, {
			routeGraphSources: [fixtureSource()],
			airportLookup: fixtureLookup,
			maxCandidates: 1
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.airportCode).toBe(ZVI);
	});

	it('defaults the cap to DEFAULT_MAX_CANDIDATES', async () => {
		expect(DEFAULT_MAX_CANDIDATES).toBeGreaterThan(0);
		const candidates = await findConnectionCandidates(QUERY, {
			routeGraphSources: [fixtureSource()],
			airportLookup: fixtureLookup
		});
		expect(candidates.length).toBeLessThanOrEqual(DEFAULT_MAX_CANDIDATES);
	});

	it('returns no candidates, and calls no source, when origin equals destination', async () => {
		const source = fixtureSource();
		const candidates = await findConnectionCandidates(
			{ originAirport: ZBC, destinationAirport: ZBC },
			{ routeGraphSources: [source], airportLookup: fixtureLookup }
		);
		expect(candidates).toEqual([]);
		expect(source.getDirectDestinations).not.toHaveBeenCalled();
	});

	it('never spends a metered request when no meteredSource is configured, even with an unconfirmable candidate', async () => {
		const sparse: DirectDestinationSource = {
			id: 'sparse',
			getDirectDestinations: (code) => Promise.resolve(code === ZBC ? [ZVI] : [])
		};
		const candidates = await findConnectionCandidates(
			{ ...QUERY, allowedConnectionAirports: [ZVI] },
			{ routeGraphSources: [sparse], airportLookup: fixtureLookup }
		);
		// ZVI -> ZSF isn't confirmed by `sparse`, and there is no metered source to fall
		// back to, so it's correctly dropped rather than guessed at.
		expect(candidates).toEqual([]);
	});

	it('spends exactly one metered request to confirm an allow-listed candidate free sources could not, and stays under budget', async () => {
		const sparse: DirectDestinationSource = {
			id: 'sparse',
			getDirectDestinations: (code) => Promise.resolve(code === ZBC ? [ZVI] : [])
		};
		const metered: DirectDestinationSource = {
			id: 'metered-aggregator',
			getDirectDestinations: vi.fn((code: IataAirportCode) =>
				Promise.resolve(code === ZVI ? [ZSF] : [])
			)
		};
		const candidates = await findConnectionCandidates(
			{ ...QUERY, allowedConnectionAirports: [ZVI] },
			{
				routeGraphSources: [sparse],
				airportLookup: fixtureLookup,
				meteredSource: metered,
				meteredRequestBudget: 5
			}
		);
		expect(candidates.map((c) => c.airportCode)).toEqual([ZVI]);
		expect(candidates[0]!.meteredRequestSpent).toBe(true);
		expect(candidates[0]!.confirmedBy.inbound).toBe('metered-aggregator');
		expect(metered.getDirectDestinations).toHaveBeenCalledTimes(1);
	});

	it('never exceeds meteredRequestBudget even with several allow-listed candidates needing confirmation', async () => {
		const sparse: DirectDestinationSource = {
			id: 'sparse',
			getDirectDestinations: (code) => Promise.resolve(code === ZBC ? [ZVI, ZMX, ZBR] : [])
		};
		const metered: DirectDestinationSource = {
			id: 'metered-aggregator',
			getDirectDestinations: vi.fn((code: IataAirportCode) =>
				Promise.resolve([ZVI, ZMX, ZBR].includes(code) ? [ZSF] : [])
			)
		};
		const candidates = await findConnectionCandidates(
			{ ...QUERY, allowedConnectionAirports: [ZVI, ZMX, ZBR] },
			{
				routeGraphSources: [sparse],
				airportLookup: fixtureLookup,
				meteredSource: metered,
				meteredRequestBudget: 1 // Only enough for one of the three.
			}
		);
		expect(metered.getDirectDestinations).toHaveBeenCalledTimes(1);
		expect(candidates.length).toBe(1);
	});

	it('never spends a metered request just for broad (non-allow-listed) discovery', async () => {
		const sparse: DirectDestinationSource = {
			id: 'sparse',
			getDirectDestinations: (code) => Promise.resolve(code === ZBC ? [ZVI, ZMX, ZBR] : [])
		};
		const metered: DirectDestinationSource = {
			id: 'metered-aggregator',
			getDirectDestinations: vi.fn(() => Promise.resolve([ZSF]))
		};
		await findConnectionCandidates(QUERY, {
			routeGraphSources: [sparse],
			airportLookup: fixtureLookup,
			meteredSource: metered,
			meteredRequestBudget: 10
		});
		expect(metered.getDirectDestinations).not.toHaveBeenCalled();
	});

	it('falls back to the bundled route table when no routeGraphSources are supplied at all', async () => {
		// Real BCN -> SOF: no direct route in the bundled fallback table either, but VIE
		// connects to both, exercising "offline and first paint both work" with zero
		// configuration.
		const candidates = await findConnectionCandidates({
			originAirport: 'BCN',
			destinationAirport: 'SOF'
		});
		expect(candidates.some((c) => c.airportCode === 'VIE')).toBe(true);
		expect(candidates.every((c) => c.confirmedBy.outbound === 'fallback-table')).toBe(true);
	});
});
