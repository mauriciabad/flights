import type { Coordinates } from '$lib/domain';
import { MemoryCacheStore } from '$lib/cache';
import { OSRM_BASE_URL } from '$lib/providers/transfers/osrm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchStayReach, pendingReach, type ReachTarget } from './fetch-reach';

const AIRPORT: Coordinates = { latitude: 41.2971, longitude: 2.0785 };

/** Metres east of the airport, so a target's distance is something a test can state. */
function eastOf(km: number): Coordinates {
	return { latitude: AIRPORT.latitude, longitude: AIRPORT.longitude + km / 83.3 };
}

function target(key: string, km: number): ReachTarget {
	return { key, coordinates: eastOf(km) };
}

/**
 * Answers OSRM's table service with one duration per requested destination, and records
 * every URL so a test can count requests and read which service was asked.
 */
function tableFetch(secondsByProfile: Record<string, number>) {
	const urls: string[] = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		urls.push(url);
		const profile = url.includes('routed-foot') ? 'foot' : 'car';
		const destinations = new URL(url).searchParams.get('destinations')?.split(';') ?? [];
		return new Response(
			JSON.stringify({ code: 'Ok', durations: [destinations.map(() => secondsByProfile[profile])] }),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	});
	return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
}

let store: MemoryCacheStore;
beforeEach(() => {
	store = new MemoryCacheStore();
});

function ctx() {
	return { signal: new AbortController().signal };
}

describe('fetchStayReach', () => {
	/**
	 * The number issue #405 asks the PR to state. Thirty candidates times three modes is
	 * ninety journeys; the OSRM table service answers one origin against many destinations in
	 * a single request, so walking and taxi together are two.
	 */
	it('costs two requests for a whole list, whatever its length', async () => {
		const { fetchImpl, urls } = tableFetch({ foot: 1200, car: 300 });
		const targets = Array.from({ length: 30 }, (_, index) => target(`p${index}`, 1 + index * 0.05));

		const result = await fetchStayReach(AIRPORT, targets, ctx(), { store, fetchImpl });

		expect(result.requestsUsed).toBe(2);
		expect(urls).toHaveLength(2);
		expect(urls[0]).toContain(`${OSRM_BASE_URL}/routed-foot/table/v1/`);
		expect(urls[1]).toContain(`${OSRM_BASE_URL}/routed-car/table/v1/`);
		expect(result.byProperty.size).toBe(30);
	});

	it('costs nothing the second time, because every pair is already in the route cache', async () => {
		const { fetchImpl } = tableFetch({ foot: 1200, car: 300 });
		const targets = [target('a', 1), target('b', 2)];

		await fetchStayReach(AIRPORT, targets, ctx(), { store, fetchImpl });
		const second = await fetchStayReach(AIRPORT, targets, ctx(), { store, fetchImpl });

		expect(second.requestsUsed).toBe(0);
		expect(second.byProperty.get('a')?.walk).toEqual({ kind: 'routed', minutes: 20 });
	});

	/**
	 * Issue #204's rule, applied one layer up. A 48 km walk cannot come back inside the
	 * 45-minute cap, so geometry answers it and the foot table is never sent at all when no
	 * candidate is close enough.
	 */
	it('never asks for a walk it already knows is too far, and says so from the distance', async () => {
		const { fetchImpl, urls } = tableFetch({ foot: 1200, car: 3600 });
		const result = await fetchStayReach(AIRPORT, [target('far', 48)], ctx(), { store, fetchImpl });

		expect(result.requestsUsed).toBe(1);
		expect(urls.every((url) => url.includes('routed-car'))).toBe(true);
		expect(result.byProperty.get('far')?.walk).toMatchObject({ kind: 'too-far' });
	});

	it('judges each answer against its mode rule, so an implausible taxi is not a taxi time', async () => {
		// 1h 40m to cover a kilometre. `maxPlausibleRoadMinutes(1)` allows 68, so this is out.
		const { fetchImpl } = tableFetch({ foot: 600, car: 6000 });
		const result = await fetchStayReach(AIRPORT, [target('near', 1)], ctx(), { store, fetchImpl });

		expect(result.byProperty.get('near')?.walk).toEqual({ kind: 'routed', minutes: 10 });
		expect(result.byProperty.get('near')?.taxi).toMatchObject({ kind: 'implausible', minutes: 100 });
	});

	it('never asks for transit, which is where the whole budget would have gone', async () => {
		const { fetchImpl, urls } = tableFetch({ foot: 600, car: 300 });
		const result = await fetchStayReach(AIRPORT, [target('near', 1)], ctx(), { store, fetchImpl });

		expect(result.byProperty.get('near')?.transit).toEqual({ kind: 'not-asked' });
		expect(urls.some((url) => url.includes('transitous'))).toBe(false);
	});

	/** AGENTS.md: show the error you got. A failed lookup reaches the screen in the adapter's
	 * own words rather than as thirty rows that silently have no taxi. */
	it('carries the provider own message through instead of reporting an absence', async () => {
		const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
		const result = await fetchStayReach(AIRPORT, [target('near', 1)], ctx(), { store, fetchImpl });

		expect(result.failures).toHaveLength(2);
		expect(result.failures[0]).toContain('HTTP 503');
		expect(result.byProperty.get('near')?.taxi).toMatchObject({ kind: 'failed' });
	});

	it('spends nothing on an empty list', async () => {
		const { fetchImpl, urls } = tableFetch({ foot: 600, car: 300 });
		const result = await fetchStayReach(AIRPORT, [], ctx(), { store, fetchImpl });
		expect(result).toEqual({ byProperty: new Map(), requestsUsed: 0, failures: [] });
		expect(urls).toHaveLength(0);
	});
});

describe('pendingReach', () => {
	/** Transit is never pending, because nothing here will ever ask it. A placeholder for an
	 * answer that is not coming is the lie this module is built to avoid. */
	it('holds the space for the two modes it is about to route, and not for the one it is not', () => {
		expect(pendingReach([target('a', 1)]).get('a')).toEqual({
			walk: { kind: 'pending' },
			transit: { kind: 'not-asked' },
			taxi: { kind: 'pending' }
		});
	});
});
