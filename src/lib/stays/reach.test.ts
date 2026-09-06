import type { Duration } from '$lib/domain';
import { MAX_PLAUSIBLE_WALK_MINUTES, maxPlausibleRoadMinutes, maxPlausibleTransitMinutes } from '$lib/domain';
import { describe, expect, it } from 'vitest';
import {
	TRANSIT_NOT_BATCHABLE_NOTE,
	describeStayReach,
	judgeReach,
	reachIsPending,
	reachLimitMinutes,
	stayReachNote,
	stayReachPoints,
	walkCouldBePlausible,
	type StayReach
} from './reach';

const minutes = (value: number) => value as Duration;

// Placa de Catalunya and Barcelona airport, 12.3 km apart, the pair osrm.ts measures against.
const NEAR = { latitude: 41.3874, longitude: 2.1686 };
const FAR = { latitude: 41.2971, longitude: 2.0785 };

describe('reachLimitMinutes', () => {
	/**
	 * The point of pinning against the domain constants rather than against numbers typed
	 * here: if issue #119's 45 minutes ever moves, this file must not keep asserting the old
	 * one and calling it a pass.
	 */
	it('reads every threshold from domain/transfer.ts rather than copying the numbers', () => {
		expect(reachLimitMinutes('walk', 100)).toBe(MAX_PLAUSIBLE_WALK_MINUTES);
		expect(reachLimitMinutes('transit', 9.7)).toBe(maxPlausibleTransitMinutes(9.7));
		expect(reachLimitMinutes('taxi', 9.7)).toBe(maxPlausibleRoadMinutes(9.7));
	});

	it('lets the walk cap ignore distance and the other two grow with it', () => {
		expect(reachLimitMinutes('walk', 2)).toBe(reachLimitMinutes('walk', 200));
		expect(reachLimitMinutes('taxi', 200)).toBeGreaterThan(reachLimitMinutes('taxi', 2));
		expect(reachLimitMinutes('transit', 200)).toBeGreaterThan(reachLimitMinutes('transit', 2));
	});
});

describe('judgeReach', () => {
	it('routes a walk inside the cap and refuses one past it', () => {
		expect(judgeReach('walk', minutes(43), 3.1)).toEqual({ kind: 'routed', minutes: 43 });
		expect(judgeReach('walk', minutes(702), 40)).toEqual({
			kind: 'implausible',
			minutes: 702,
			limit: MAX_PLAUSIBLE_WALK_MINUTES
		});
	});

	/** The boundary belongs to the traveller: `isPlausibleTransfer` uses `<=` and so does this. */
	it('keeps a journey that lands exactly on the limit', () => {
		expect(judgeReach('walk', MAX_PLAUSIBLE_WALK_MINUTES, 3.4).kind).toBe('routed');
	});

	/**
	 * Issue #220's artefact, in the mode that produces it: OSRM's car profile prices an
	 * untagged ferry at about 5 km/h, so Athens to Naxos comes back at 33 hours over 156.6 km.
	 */
	it('refuses a road answer the router spent on a boat', () => {
		expect(judgeReach('taxi', minutes(33 * 60), 156.6).kind).toBe('implausible');
		expect(judgeReach('taxi', minutes(17), 12.3).kind).toBe('routed');
	});
});

describe('walkCouldBePlausible', () => {
	it('answers from geometry so a bed across the county is never asked about', () => {
		expect(walkCouldBePlausible(NEAR, NEAR, 4.5)).toBe(true);
		expect(walkCouldBePlausible(NEAR, FAR, 4.5)).toBe(false);
	});
});

describe('stayReachPoints', () => {
	it('prints only what a router answered, in walk, transit, taxi order', () => {
		const reach: StayReach = {
			walk: { kind: 'routed', minutes: minutes(43) },
			transit: { kind: 'routed', minutes: minutes(65) },
			taxi: { kind: 'routed', minutes: minutes(4) }
		};
		expect(stayReachPoints(reach)).toEqual([
			{ mode: 'walk', time: '43m', word: 'Walk' },
			{ mode: 'transit', time: '1h 5m', word: 'Public transport' },
			{ mode: 'taxi', time: '4m', word: 'Taxi' }
		]);
	});

	/**
	 * Issue #405's acceptance, and the rule the whole feature turns on: a mode that is not a
	 * real option gets no data point, and no case except `routed` ever produces a number.
	 */
	it('drops every mode nobody routed, whatever the reason', () => {
		const reach: StayReach = {
			walk: { kind: 'too-far', straightLineKm: 48.3, limit: MAX_PLAUSIBLE_WALK_MINUTES },
			transit: { kind: 'not-asked' },
			taxi: { kind: 'implausible', minutes: minutes(1980), limit: minutes(1315) }
		};
		expect(stayReachPoints(reach)).toEqual([]);
		expect(stayReachPoints(undefined)).toEqual([]);
	});

	it('drops a failed lookup rather than printing the mode with no time', () => {
		expect(
			stayReachPoints({
				walk: { kind: 'failed', message: 'OSRM walk: network - request to /table failed' },
				transit: { kind: 'not-asked' },
				taxi: { kind: 'no-route' }
			})
		).toEqual([]);
	});
});

describe('reachIsPending', () => {
	it('is true while any mode is still being looked up', () => {
		expect(
			reachIsPending({ walk: { kind: 'pending' }, transit: { kind: 'not-asked' }, taxi: { kind: 'pending' } })
		).toBe(true);
		expect(
			reachIsPending({
				walk: { kind: 'no-route' },
				transit: { kind: 'not-asked' },
				taxi: { kind: 'routed', minutes: minutes(6) }
			})
		).toBe(false);
		expect(reachIsPending(undefined)).toBe(false);
	});
});

describe('describeStayReach', () => {
	it('says what happened to every mode, including the ones with no number', () => {
		expect(
			describeStayReach({
				walk: { kind: 'too-far', straightLineKm: 48.3, limit: minutes(45) },
				transit: { kind: 'not-asked' },
				taxi: { kind: 'routed', minutes: minutes(52) }
			})
		).toEqual([
			'Walk: 48.3 km away in a straight line, further than 45m reaches',
			'Public transport: not looked up',
			'Taxi 52m'
		]);
	});

	it('hands back whatever the provider said, verbatim, when a lookup failed', () => {
		expect(
			describeStayReach({
				walk: { kind: 'failed', message: 'OSRM walk: network - HTTP 429' },
				transit: { kind: 'not-asked' },
				taxi: { kind: 'no-route' }
			})
		).toEqual([
			'Walk: OSRM walk: network - HTTP 429',
			'Public transport: not looked up',
			'Taxi: no route found'
		]);
	});
});

describe('stayReachNote', () => {
	const routed: StayReach = {
		walk: { kind: 'routed', minutes: minutes(20) },
		transit: { kind: 'not-asked' },
		taxi: { kind: 'routed', minutes: minutes(6) }
	};

	it('explains the missing bus times once the road ones have arrived', () => {
		expect(stayReachNote([routed, routed])).toBe(TRANSIT_NOT_BATCHABLE_NOTE);
	});

	it('says nothing before any lookup has answered, where it would explain an absence nobody has noticed yet', () => {
		expect(stayReachNote([])).toBeUndefined();
		expect(
			stayReachNote([
				{ walk: { kind: 'not-asked' }, transit: { kind: 'not-asked' }, taxi: { kind: 'not-asked' } }
			])
		).toBeUndefined();
	});

	it('says nothing once a property does have a bus time, since the claim would no longer be true', () => {
		expect(
			stayReachNote([routed, { ...routed, transit: { kind: 'routed', minutes: minutes(35) } }])
		).toBeUndefined();
	});
});
