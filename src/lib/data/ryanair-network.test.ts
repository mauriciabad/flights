import { describe, expect, it } from 'vitest';
import {
	directDestinationsFrom,
	loadBundledRyanairNetwork,
	newerSnapshot,
	type RyanairNetworkSnapshot
} from './ryanair-network';

/**
 * Two kinds of test here. The `directDestinationsFrom`/`newerSnapshot` ones are ordinary
 * unit tests on hand-built inputs. The ones reading the generated file are guarding
 * something else: scripts/fetch-ryanair-network.mjs derives that file independently of
 * `buildNetworkSnapshot` in the adapter (a .mjs build script cannot import the TS), so
 * these assert the invariants both derivations have to agree on. A script that starts
 * writing city codes, dropping the timezone table or truncating the network fails here
 * rather than in production, where the symptom would be the app quietly reporting that
 * Ryanair does not serve most of Europe.
 */

const IATA_CODE = /^[A-Z]{3}$/;

function snapshotAt(fetchedAt: string): RyanairNetworkSnapshot {
	return { fetchedAt, destinationsByOrigin: {}, timeZonesByIataCode: {} };
}

describe('directDestinationsFrom', () => {
	const snapshot: RyanairNetworkSnapshot = {
		fetchedAt: '2026-09-04T10:00:00.000Z',
		destinationsByOrigin: { BCN: ['STN', 'AHO'], AHO: [] },
		timeZonesByIataCode: { BCN: 'Europe/Madrid' }
	};

	it('returns the destinations of an airport in the network', () => {
		expect(directDestinationsFrom(snapshot, 'BCN')).toEqual(['STN', 'AHO']);
	});

	it('returns an empty list for an airport Ryanair does not serve, rather than undefined', () => {
		// DUS is absent from the snapshot, which is the same answer the per-airport routes
		// endpoint gave as an HTTP 404 (issue #89). The caller must not be able to tell
		// "not in the network" from "in the network, flies nowhere" — both are `[]`.
		expect(directDestinationsFrom(snapshot, 'DUS')).toEqual([]);
		expect(directDestinationsFrom(snapshot, 'AHO')).toEqual([]);
	});

	it('accepts a lowercase or padded code, since a URL parameter can be either', () => {
		expect(directDestinationsFrom(snapshot, ' bcn ')).toEqual(['STN', 'AHO']);
	});

	it('never throws on an empty code', () => {
		expect(directDestinationsFrom(snapshot, '')).toEqual([]);
	});
});

describe('newerSnapshot', () => {
	it('picks the more recently fetched of the two', () => {
		const older = snapshotAt('2026-08-01T00:00:00.000Z');
		const newer = snapshotAt('2026-09-01T00:00:00.000Z');
		expect(newerSnapshot(older, newer)).toBe(newer);
		expect(newerSnapshot(newer, older)).toBe(newer);
	});

	it('discards a snapshot that cannot date itself', () => {
		const dated = snapshotAt('2026-08-01T00:00:00.000Z');
		const undated = snapshotAt('not a date');
		expect(newerSnapshot(undated, dated)).toBe(dated);
		expect(newerSnapshot(dated, undated)).toBe(dated);
	});
});

describe('the generated snapshot', () => {
	it('covers Ryanair’s whole network, not a sample of it', async () => {
		const snapshot = await loadBundledRyanairNetwork();
		const origins = Object.keys(snapshot.destinationsByOrigin);

		// Ryanair served 224 airports on 2026-09-04. The floor is deliberately far below
		// that: this is here to catch a truncated fetch, not to pin the airline's size.
		expect(origins.length).toBeGreaterThan(150);
		expect(Object.keys(snapshot.timeZonesByIataCode).length).toBe(origins.length);
	});

	it('holds airport codes on both sides of every edge, never city or country codes', async () => {
		const snapshot = await loadBundledRyanairNetwork();
		for (const [origin, destinations] of Object.entries(snapshot.destinationsByOrigin)) {
			expect(origin).toMatch(IATA_CODE);
			for (const destination of destinations) expect(destination).toMatch(IATA_CODE);
		}
	});

	it('is closed: every destination is itself an airport the snapshot knows', async () => {
		// This is what makes an absent origin mean "not in Ryanair's network" rather than
		// "we did not fetch that one". If it ever fails, absence has stopped being an
		// answer and `directDestinationsFrom` is lying about the 404 case.
		const snapshot = await loadBundledRyanairNetwork();
		const known = new Set(Object.keys(snapshot.destinationsByOrigin));
		const unknown = Object.values(snapshot.destinationsByOrigin)
			.flat()
			.filter((code) => !known.has(code));
		expect([...new Set(unknown)]).toEqual([]);
	});

	it('excludes the airports Ryanair does not serve, so nothing has to ask about them', async () => {
		// The five the production measurement caught 404ing, once per search each.
		const snapshot = await loadBundledRyanairNetwork();
		for (const code of ['ALG', 'DUS', 'EVN', 'IST', 'LED']) {
			expect(snapshot.destinationsByOrigin[code]).toBeUndefined();
		}
	});

	it('gives every airport an IANA zone name, which is the other half of what it is for', async () => {
		const snapshot = await loadBundledRyanairNetwork();
		for (const zone of Object.values(snapshot.timeZonesByIataCode)) {
			expect(zone).toMatch(/^[A-Za-z_]+\/[A-Za-z_/-]+$/);
		}
		expect(snapshot.timeZonesByIataCode.BCN).toBe('Europe/Madrid');
	});

	it('dates itself, so the adapter can tell it from a cached snapshot', async () => {
		const snapshot = await loadBundledRyanairNetwork();
		expect(Number.isFinite(Date.parse(snapshot.fetchedAt))).toBe(true);
	});
});
