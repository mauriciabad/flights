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
	// STN is in the network with a route and has no zone, which is issue #371's half-known
	// airport. A live refresh produces one whenever Ryanair decommissions an airport
	// mid-answer or sends a `timeZone` string `isSupportedTimeZone` rejects.
	const snapshot: RyanairNetworkSnapshot = {
		fetchedAt: '2026-09-04T10:00:00.000Z',
		destinationsByOrigin: { BCN: ['STN', 'AHO'], AHO: [], STN: ['BCN'] },
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

	/**
	 * Issue #371, the invariant this app chose. An airport with routes and no zone is still
	 * answered for, so it is still proposed as a connection candidate and every other flight
	 * provider still gets asked to price the leg. Ryanair's own failure to time it is
	 * reported by `searchOffers`'s `no-time-zone` (#359) and reaches the traveller as
	 * "A flight here could not be timed", which is a true sentence about a real flight.
	 *
	 * The rejected alternative was dropping the airport from `destinationsByOrigin` too. It
	 * reads as the safer half, and it is the more expensive one: the city disappears from
	 * the search entirely, with nothing on screen saying why, over a zone string one
	 * provider sent badly. `buildNetworkSnapshot`'s own comment carries the full reasoning.
	 */
	it('still answers for an airport in the network whose zone the snapshot never learned', () => {
		expect(snapshot.timeZonesByIataCode.STN).toBeUndefined();
		expect(directDestinationsFrom(snapshot, 'STN')).toEqual(['BCN']);
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
	});

	/**
	 * Issue #371. This is a canary on the refresh, not a rule the app leans on — the code
	 * handles a half-known airport by proposing it anyway and reporting what it cannot
	 * price, which the `directDestinationsFrom` tests above pin. The shipped file was whole
	 * on 2026-09-04 (224 origins, 224 zones, 0 missing), so nothing reaching a traveller
	 * today depends on that handling, and a refresh that changes it is worth reading before
	 * it lands: Ryanair has either retired an airport mid-answer or started sending a
	 * `timeZone` string `isSupportedTimeZone` rejects, and the second would be every route
	 * at once. When this fails, go and look at the airport it names. Do not delete the line.
	 *
	 * The count equality this replaces let two different sets of the same size pass.
	 */
	it('knows a zone for every airport in the network, and none outside it', async () => {
		const snapshot = await loadBundledRyanairNetwork();
		const origins = Object.keys(snapshot.destinationsByOrigin);

		expect(origins.filter((code) => !(code in snapshot.timeZonesByIataCode))).toEqual([]);
		// The other direction says the two derivations still agree about which airports
		// exist. `scripts/fetch-ryanair-network.mjs` writes this file without importing
		// `buildNetworkSnapshot` (a .mjs script cannot), so nothing but this holds them
		// to one shape.
		const zoned = Object.keys(snapshot.timeZonesByIataCode);
		expect(zoned.filter((code) => !(code in snapshot.destinationsByOrigin))).toEqual([]);
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
