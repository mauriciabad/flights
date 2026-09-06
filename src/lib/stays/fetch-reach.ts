/**
 * What the whole candidate list costs to route, and the measurement that decided it.
 *
 * Issue #405 calls the request budget "the whole design problem" and it is right. Thirty
 * properties times three modes is ninety journeys, and the list re-derives whenever the
 * stopover changes.
 *
 * ## The measurement
 *
 * | mode | how | requests per list render |
 * | --- | --- | --- |
 * | walk | OSRM `table`, one origin against every candidate | 1 cold, 0 warm |
 * | taxi | OSRM `table`, same shape on the car network | 1 cold, 0 warm |
 * | transit | not asked here | 0 |
 *
 * Two, cold. Zero once the 30-day route cache holds the pairs, which it does after the first
 * look at a connection and for every later visit to it. `findTransfersToMany` reads the cache
 * per destination first and asks one table request for whatever is left, so a list where 28
 * of 30 are cached still costs exactly one request per mode, not 28 saved and 2 spent.
 *
 * ## Why transit is not in that table
 *
 * MOTIS has a one-to-many service and it refuses this. Asked on 2026-09-06:
 *
 * ```
 * GET api.transitous.org/api/v1/one-to-many?one=41.2971;2.0785&many=41.3874;2.1686&mode=TRANSIT
 * 400 {"error":"mode TRANSIT not supported for one-to-many"}
 * ```
 *
 * The same request with `mode=CAR` answers `[{"duration":9.83E2}]`, so the endpoint is
 * reachable and the refusal is about transit specifically. What is left is `/plan`, one
 * origin to one destination, which makes a bus time for the list thirty requests to a free
 * but volunteer-run aggregator whose whole search budget in this app is twelve
 * (`MAX_TRANSIT_LOOKUPS_PER_SEARCH`). Scrolling the list twice would spend five searches'
 * worth of somebody else's server.
 *
 * The tempting third option is `/api/v1/one-to-all`, which does answer transit and does it in
 * one request: travel time from the airport to every reachable STOP. Stitch an OSRM walk from
 * the nearest stop onto that and every row gets a bus figure for two requests. This app has
 * the vocabulary to show it honestly, too — `domain/fare.ts` exists so an estimate can reach
 * a reader's eyes without ever becoming a `price` — so "we do not estimate" is not the reason
 * to refuse it. AGENTS.md's rule is narrower than that: never present an estimate as a FACT.
 *
 * It was measured rather than argued. `.audit/probe-transit-stitch-agent-acc83cf3.mjs`, Munich
 * airport against Hostelworld's real Munich list, 7 October 2026, 9am:
 *
 * - **Coverage is not the problem.** One request returned 8,702 reachable stops inside 90
 *   minutes, and all 15 properties had one within 250 m. Nearest stop was 0.02 to 0.24 km.
 * - **The figure is roughly right.** Against what `/plan` answers door to door for the same
 *   pair, the stitch ran from 13 minutes long to 2 minutes short on journeys of about 50
 *   minutes.
 * - **The order is wrong.** Sorted by the stitch and sorted by `/plan`, **1 of 8 properties
 *   landed in the same position.** The stitch also roughly doubled the apparent spread across
 *   the list, 42-62 minutes against a true 44-53.
 *
 * The third number is the one that decides it, and the reason it is not fixable by adding a
 * wait allowance or widening it into a range: the error is not a missing wait. `one-to-all`
 * reports the earliest arrival at each stop, while `/plan` optimises the whole journey and
 * routinely picks a different one. The two are different quantities, not the same quantity
 * measured loosely, so no label makes the ranking true.
 *
 * A bus column on a list of thirty exists to be compared, and a figure that misorders seven
 * rows in eight is worst at exactly the job it was added for. So the column stays empty and
 * says why. If the owner would rather have approximate times than none, the change is small
 * and the measurement above is what he would be trading away.
 *
 * So transit stays `not-asked` on every row, `stayReachNote` says so once above the list, and
 * the existing one-property lookup (`search/transit-schedule.ts`, the transport row's "check
 * public transport") is how a real bus time reaches a row. That path already exists, already
 * has a budget, and already puts the cost in front of the person choosing to spend it.
 */

import type { Coordinates, Duration } from '$lib/domain';
import { greatCircleDistanceKm } from '$lib/domain';
import type { ProviderContext } from '$lib/providers/types';
import type { OsrmProviderOptions } from '$lib/providers/transfers/osrm';
import { MAX_WALK_ROUTE_DISTANCE_KM, findTransfersToMany } from '$lib/providers/transfers/osrm';
import { judgeReach, reachLimitMinutes, walkCouldBePlausible, type ModeReach, type StayReach } from './reach';
import { propertyKey, propertyOf, type PropertyStayOptions } from './types';

/** One property, reduced to what routing it needs. Keyed by `propertyKey` so the answer
 * lands back on the right `StayChoice` without carrying the whole group through. */
export interface ReachTarget {
	key: string;
	coordinates: Coordinates;
}

/** Every candidate as something to route to, keyed the way `describeStayChoices` keys its
 * rows, so the answer lands back on the right one. Here rather than at the call site because
 * the two keyings have to be the same keying. */
export function stayReachTargets(groups: readonly PropertyStayOptions[]): ReachTarget[] {
	return groups.map((group) => {
		const property = propertyOf(group);
		return { key: propertyKey(property), coordinates: property.coordinates };
	});
}

export interface ReachLookupResult {
	byProperty: Map<string, StayReach>;
	/** What this call actually spent, for the cost check and for saying so in a PR. */
	requestsUsed: number;
	/** The provider's own sentences, verbatim, for a surface to print beside the list.
	 * Empty on the ordinary run. */
	failures: string[];
}

/** Everything pending, which is what a caller shows while this runs. Transit is `not-asked`
 * from the very first frame rather than pending, because nothing here will ever ask it and a
 * placeholder promising an answer that is not coming is the lie this file exists to avoid. */
export function pendingReach(targets: readonly ReachTarget[]): Map<string, StayReach> {
	return new Map(
		targets.map((target) => [
			target.key,
			{
				walk: { kind: 'pending' },
				transit: { kind: 'not-asked' },
				taxi: { kind: 'pending' }
			} satisfies StayReach
		])
	);
}

/**
 * Walking and taxi times from `origin` to every target, in two table requests or fewer.
 *
 * Sequential rather than `Promise.all`, matching `search/transit-schedule.ts`'s reasoning for
 * the same choice: the adapter already chains its 1100ms gap across concurrent callers
 * (issue #213), so firing both at once buys nothing and only makes the second one's wait
 * invisible to whoever is reading this.
 */
export async function fetchStayReach(
	origin: Coordinates,
	targets: readonly ReachTarget[],
	ctx: ProviderContext,
	options: OsrmProviderOptions = {}
): Promise<ReachLookupResult> {
	const byProperty = new Map<string, StayReach>();
	const failures: string[] = [];
	let requestsUsed = 0;
	if (targets.length === 0) return { byProperty, requestsUsed, failures };

	// A walk past this distance cannot come back inside `MAX_PLAUSIBLE_WALK_MINUTES`, so the
	// answer is known from geometry and the router never has to be asked. Filtering here
	// rather than judging the reply keeps a bed 48 km out from holding a "looking" placeholder
	// for a mode it was never going to have, and keeps the table below the demo server's own
	// size cap on a long list.
	const walkable = targets.filter((target) =>
		walkCouldBePlausible(origin, target.coordinates, MAX_WALK_ROUTE_DISTANCE_KM)
	);
	const walkableKeys = new Set(walkable.map((target) => target.key));

	const walk = await lookup('walk', origin, walkable, ctx, options);
	requestsUsed += walk.requestsUsed;
	if (walk.failure) failures.push(walk.failure);

	const drive = await lookup('drive', origin, targets, ctx, options);
	requestsUsed += drive.requestsUsed;
	if (drive.failure) failures.push(drive.failure);

	for (const target of targets) {
		const straightLineKm = greatCircleDistanceKm(origin, target.coordinates);
		byProperty.set(target.key, {
			// A target filtered out above is neither pending nor unasked: geometry answered it,
			// and `too-far` is what lets the map dialog say "too far to walk" for a bed no
			// router was ever asked about.
			walk: walkableKeys.has(target.key)
				? answerFor('walk', walk, target.key, straightLineKm)
				: { kind: 'too-far', straightLineKm, limit: reachLimitMinutes('walk', straightLineKm) },
			transit: { kind: 'not-asked' },
			taxi: answerFor('taxi', drive, target.key, straightLineKm)
		});
	}

	return { byProperty, requestsUsed, failures };
}

interface ModeLookup {
	minutesByKey: Map<string, Duration>;
	answered: Set<string>;
	requestsUsed: number;
	failure?: string;
}

async function lookup(
	mode: 'walk' | 'drive',
	origin: Coordinates,
	targets: readonly ReachTarget[],
	ctx: ProviderContext,
	options: OsrmProviderOptions
): Promise<ModeLookup> {
	const empty: ModeLookup = { minutesByKey: new Map(), answered: new Set(), requestsUsed: 0 };
	if (targets.length === 0) return empty;

	const result = await findTransfersToMany(
		mode,
		origin,
		targets.map((target) => target.coordinates),
		ctx,
		options
	);
	if (!result.ok) {
		// AGENTS.md, "show the error you got, never the one you assumed": the adapter's own
		// message and code reach the screen, and this call contributes no answers rather than
		// a row of silent absences that would read as "no taxi to any of these".
		return {
			...empty,
			requestsUsed: result.requestsUsed,
			failure: `OSRM ${mode}: ${result.error.code} - ${result.error.message}`
		};
	}

	const minutesByKey = new Map<string, Duration>();
	const answered = new Set<string>();
	result.data.forEach((transfer, index) => {
		const key = targets[index].key;
		answered.add(key);
		if (transfer) minutesByKey.set(key, transfer.duration);
	});
	return { minutesByKey, answered, requestsUsed: result.requestsUsed };
}

function answerFor(
	mode: 'walk' | 'taxi',
	result: ModeLookup,
	key: string,
	straightLineKm: number
): ModeReach {
	if (result.failure) return { kind: 'failed', message: result.failure };
	if (!result.answered.has(key)) return { kind: 'not-asked' };
	const minutes = result.minutesByKey.get(key);
	// Answered but with nothing in it is OSRM saying no path exists between these points,
	// which `findTransfersToMany` keeps distinct from an error on purpose: one unreachable
	// hotel among thirty is an ordinary result.
	if (minutes === undefined) return { kind: 'no-route' };
	return judgeReach(mode, minutes, straightLineKm);
}
