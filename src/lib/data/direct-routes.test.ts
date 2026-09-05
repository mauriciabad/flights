import { describe, expect, it } from 'vitest';
import {
	hasDirectRoute,
	loadBundledDirectRoutes,
	neighboursOf,
	type DirectRouteGraph
} from './direct-routes';

/**
 * Two kinds of test, the same split ryanair-network.test.ts makes. The `neighboursOf` and
 * `hasDirectRoute` ones are ordinary unit tests on a hand-built graph. The ones reading the
 * generated file guard the invariants scripts/fetch-direct-routes.mjs has to hold up, since
 * a .mjs build script cannot import this TS and nothing else checks its output: a parser
 * that starts dropping the tail of every table, writing one direction of a pair, or naming
 * airports the graph has no entry for fails here rather than in production, where the
 * symptom is a search quietly proposing fewer cities.
 */

const IATA_CODE = /^[A-Z]{3}$/;

/** Matches the floors scripts/fetch-direct-routes.mjs refuses to write below. Measured
 * 2026-09-05: 309 airports and 8,111 pairs, so both sit far under the real numbers and are
 * here to catch a truncated fetch rather than to pin the size of the network. */
const MIN_AIRPORTS = 250;
const MIN_UNDIRECTED_PAIRS = 5000;

const graph: DirectRouteGraph = {
	fetchedAt: '2026-09-05T10:00:00.000Z',
	neighbours: { BVC: ['EMA', 'LIS'], EMA: ['BVC', 'PFO'], PFO: ['EMA'], LIS: ['BVC'] }
};

describe('neighboursOf', () => {
	it('returns every airport with a known direct route to or from the code', () => {
		expect(neighboursOf(graph, 'BVC')).toEqual(['EMA', 'LIS']);
	});

	it('returns an empty list for a code no article named, rather than undefined', () => {
		expect(neighboursOf(graph, 'ZZZ')).toEqual([]);
	});

	it('accepts a lowercase or padded code, since a URL parameter can be either', () => {
		expect(neighboursOf(graph, ' bvc ')).toEqual(['EMA', 'LIS']);
	});

	it('never throws on an empty code', () => {
		expect(neighboursOf(graph, '')).toEqual([]);
	});
});

describe('hasDirectRoute', () => {
	it('answers both directions of an edge', () => {
		expect(hasDirectRoute(graph, 'BVC', 'EMA')).toBe(true);
		expect(hasDirectRoute(graph, 'EMA', 'BVC')).toBe(true);
	});

	it('is false for a pair the table does not name, which is not the same as no such route', () => {
		expect(hasDirectRoute(graph, 'BVC', 'PFO')).toBe(false);
	});

	it('is false rather than a throw for a code the graph has never heard of', () => {
		expect(hasDirectRoute(graph, 'ZZZ', 'EMA')).toBe(false);
		expect(hasDirectRoute(graph, 'EMA', '')).toBe(false);
	});

	it('normalises case on both sides, like neighboursOf', () => {
		expect(hasDirectRoute(graph, 'bvc', ' ema ')).toBe(true);
	});
});

describe('the generated graph', () => {
	it('is symmetric: every edge is recorded on both of its airports', async () => {
		// The generator writes both directions so no loader has to remember to mirror, and
		// `connections.ts` asks about the inbound leg from the candidate's side. A one-sided
		// edge would make a candidate confirmable in one direction and invisible in the other.
		const shipped = await loadBundledDirectRoutes();
		const oneSided: string[] = [];
		for (const [code, codes] of Object.entries(shipped.neighbours)) {
			for (const other of codes) {
				if (!shipped.neighbours[other]?.includes(code)) oneSided.push(`${code} -> ${other}`);
			}
		}
		expect(oneSided).toEqual([]);
	});

	it('is closed: every neighbour is itself an airport the graph has an entry for', async () => {
		const shipped = await loadBundledDirectRoutes();
		const known = new Set(Object.keys(shipped.neighbours));
		const unknown = Object.values(shipped.neighbours)
			.flat()
			.filter((code) => !known.has(code));
		expect([...new Set(unknown)]).toEqual([]);
	});

	it('holds airport codes on both sides of every edge, never city or country codes', async () => {
		// The seed drops IATA metropolitan codes (LON, PAR, MIL, ...) before anything is
		// fetched, because every airport-level provider rejects them. This is what proves the
		// drop happened.
		const shipped = await loadBundledDirectRoutes();
		for (const [code, codes] of Object.entries(shipped.neighbours)) {
			expect(code).toMatch(IATA_CODE);
			for (const other of codes) expect(other).toMatch(IATA_CODE);
		}
	});

	it('clears the same floors the generator refuses to write below', async () => {
		const shipped = await loadBundledDirectRoutes();
		const airports = Object.keys(shipped.neighbours);
		const directed = airports.reduce((n, code) => n + shipped.neighbours[code].length, 0);
		expect(airports.length).toBeGreaterThanOrEqual(MIN_AIRPORTS);
		expect(directed / 2).toBeGreaterThanOrEqual(MIN_UNDIRECTED_PAIRS);
	});

	it('names no airport as its own neighbour', async () => {
		const shipped = await loadBundledDirectRoutes();
		const selfEdges = Object.entries(shipped.neighbours)
			.filter(([code, codes]) => codes.includes(code))
			.map(([code]) => code);
		expect(selfEdges).toEqual([]);
	});

	it('dates itself, so a reader can tell how stale a hand-edited source has gone', async () => {
		const shipped = await loadBundledDirectRoutes();
		expect(Number.isFinite(Date.parse(shipped.fetchedAt))).toBe(true);
	});

	it('connects Boa Vista to East Midlands and East Midlands to Paphos (issue #361)', async () => {
		// The whole point of the file. Kiwi sells BVC to EMA (TUI BY 725) and EMA to PFO (TUI
		// BY 7666/7784), measured live 2026-09-05, and no candidate source the app had could
		// propose East Midlands: it is absent from Boa Vista's sampled destination list and it
		// is nobody's metro sibling. Boa Vista's article names it under TUI Airways, East
		// Midlands' article names Paphos, and symmetrising the two is what closes the route.
		//
		// Pinned deliberately, unlike the floors above. If a Wikipedia edit takes one of these
		// four assertions down, the acceptance route in docs/ACCEPTANCE.md has quietly stopped
		// working and this is where that should surface.
		const shipped = await loadBundledDirectRoutes();
		expect(hasDirectRoute(shipped, 'BVC', 'EMA')).toBe(true);
		expect(hasDirectRoute(shipped, 'EMA', 'BVC')).toBe(true);
		expect(hasDirectRoute(shipped, 'EMA', 'PFO')).toBe(true);
		expect(hasDirectRoute(shipped, 'PFO', 'EMA')).toBe(true);
	});
});
