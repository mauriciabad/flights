/**
 * How long it takes to get from the connection airport to one candidate property, per mode.
 *
 * Issue #405, the owner: **"it is missing the transport time. I expect to see data points
 * with icon and time based on feasibility by transport method: 🚶🏻43min 🚌10min 🚘4min"**.
 * The row showed `13.1 km from airport` instead, and a straight line is not an answer to
 * "can I walk to this", which is the question the figure was standing in for.
 *
 * ## "Based on feasibility" is the interesting half
 *
 * A mode that is not a real option gets no data point. The rules for that already exist and
 * already carry their reasoning, in `domain/transfer.ts`: `MAX_PLAUSIBLE_WALK_MINUTES` for
 * walking (issue #119, "'Walk 11h 42m' WTF dont even show this"), `maxPlausibleRoadMinutes`
 * for a taxi and `maxPlausibleTransitMinutes` for a bus. This file applies those three and
 * invents no fourth.
 *
 * The constants rather than `search/resources.ts`'s `isPlausibleTransfer`, which is the same
 * switch over the same three rules. `search/` imports `stays/`, so importing it back would
 * close a cycle. Both read from `domain/transfer.ts`, so there is still one source for what
 * "too long" means, and `reach.test.ts` pins the thresholds against the domain constants
 * rather than against copied numbers.
 *
 * ## Seven answers, not a duration and a maybe
 *
 * A `Duration | undefined` cannot tell a walk nobody has asked about yet from a walk that
 * came back at two hours, and those two have to render differently: the first is a
 * placeholder, the second is a mode this property does not have. `costIsUnknown` in
 * `domain/transfer.ts` is this codebase's own precedent for splitting an overloaded absence
 * into named cases, and it is there because an absent price read as zero in every total.
 *
 * Only `routed` ever prints a number. That is the rule this repo holds every screen to
 * (AGENTS.md, "never present an estimate as a fact"): a time on the row came from a router
 * or it is not on the row.
 */

import type { Coordinates, Duration, TransferMode } from '$lib/domain';
import {
	MAX_PLAUSIBLE_WALK_MINUTES,
	greatCircleDistanceKm,
	maxPlausibleRoadMinutes,
	maxPlausibleTransitMinutes
} from '$lib/domain';
import { formatDuration } from '$lib/format';
import { formatDistanceKm } from './distance';

/**
 * The three modes a traveller picks between for the hop out to a bed.
 *
 * `taxi` rather than `drive`, and the difference is the traveller rather than the physics.
 * Somebody who has just landed has no car, so the road option they are choosing between is a
 * taxi, which is also what `pickBestTransfer` prefers and what the itinerary's own ground
 * legs carry. `providers/transfers/osrm.ts` already says the two ride one road network and
 * one driving route answers both.
 */
export const REACH_MODES = ['walk', 'transit', 'taxi'] as const;
export type ReachMode = (typeof REACH_MODES)[number] & TransferMode;

/** What is known about one mode's journey to one property. */
export type ModeReach =
	/** A router answered, and the answer is inside the plausibility rule for this mode.
	 * The only case that prints a number. */
	| { kind: 'routed'; minutes: Duration }
	/** A router answered and the rule refused it: an eleven-hour walk, a taxi the router
	 * priced as a car ferry. Keeps both numbers so a surface with room can say which
	 * journey it declined and what it declined it against, rather than going quiet. */
	| { kind: 'implausible'; minutes: Duration; limit: Duration }
	/** Not asked, because geometry settles it without a request. Great-circle distance is a
	 * lower bound on any route, so past a certain separation no answer can come back inside
	 * the rule and asking spends a request on a refusal. Distinct from `implausible` because
	 * nothing was measured: there is a distance to report, not a duration. */
	| { kind: 'too-far'; straightLineKm: number; limit: Duration }
	/** A router was asked and found no way between these two points. */
	| { kind: 'no-route' }
	/** A lookup is in flight. Distinct from every other case so a row can hold the space
	 * instead of rendering "this property has no walk" for a second and then changing its
	 * mind. */
	| { kind: 'pending' }
	/** Nobody asked. Why is a fact about the whole list rather than about this property,
	 * so it is said once above the list (`stayReachNote`) instead of thirty times. */
	| { kind: 'not-asked' }
	/** Asked, and it failed. Carries the provider's own words, per AGENTS.md's "show the
	 * error you got, never the one you assumed". */
	| { kind: 'failed'; message: string };

export type StayReach = Readonly<Record<ReachMode, ModeReach>>;

/** Nothing asked about any mode yet: what a property has before a lookup starts, and what
 * it keeps if none ever runs. */
export const UNASKED_REACH: StayReach = {
	walk: { kind: 'not-asked' },
	transit: { kind: 'not-asked' },
	taxi: { kind: 'not-asked' }
};

/**
 * The longest this mode may take between two points this far apart before it stops being
 * transport. One switch over `ReachMode` rather than three call sites choosing a rule, and
 * exhaustive so a fourth mode cannot arrive unjudged — the exact silence `isPlausibleTransfer`
 * documents having lived with until issue #119's second half.
 */
export function reachLimitMinutes(mode: ReachMode, straightLineKm: number): Duration {
	switch (mode) {
		case 'walk':
			return MAX_PLAUSIBLE_WALK_MINUTES;
		case 'transit':
			return maxPlausibleTransitMinutes(straightLineKm);
		case 'taxi':
			return maxPlausibleRoadMinutes(straightLineKm);
	}
}

/** A router's answer, judged. The one function that turns minutes into a `ModeReach`, so
 * the OSRM tables and any later transit answer cannot disagree about where the line is. */
export function judgeReach(mode: ReachMode, minutes: Duration, straightLineKm: number): ModeReach {
	const limit = reachLimitMinutes(mode, straightLineKm);
	return minutes <= limit ? { kind: 'routed', minutes } : { kind: 'implausible', minutes, limit };
}

/**
 * Whether a walk between two points this far apart could possibly come back under the cap.
 *
 * Great-circle distance is a lower bound on any real path, so past this the router cannot
 * answer inside `MAX_PLAUSIBLE_WALK_MINUTES` and asking is spending a table slot on a
 * refusal. `providers/transfers/osrm.ts` makes the same call for the same reason and owns
 * the walking speed the bound is built from.
 */
export function walkCouldBePlausible(from: Coordinates, to: Coordinates, maxWalkRouteKm: number): boolean {
	return greatCircleDistanceKm(from, to) <= maxWalkRouteKm;
}

/** One data point on the row: a glyph and a time. Only `routed` modes produce one, and
 * `REACH_MODES`'s order is the order they print in, slowest mode first, which is the order
 * the owner wrote them in and the order a traveller rules them out in. */
export interface ReachPoint {
	mode: ReachMode;
	/** Through `formatDuration`, so it reads `43m` and `1h 5m` with no padded digits. */
	time: string;
	/** The mode in words. `ModeIcon` is `aria-hidden` by design and has no prop to turn that
	 * off, so a chip is a glyph and a number with nothing a screen reader can read; this is
	 * what it announces instead. */
	word: string;
}

const MODE_WORD: Record<ReachMode, string> = { walk: 'Walk', transit: 'Public transport', taxi: 'Taxi' };

export function stayReachPoints(reach: StayReach | undefined): ReachPoint[] {
	if (!reach) return [];
	return REACH_MODES.flatMap((mode) => {
		const answer = reach[mode];
		if (answer.kind !== 'routed') return [];
		return [{ mode, time: formatDuration(answer.minutes), word: MODE_WORD[mode] }];
	});
}

/** Whether any lookup is still running for this property, so a row can hold the space. */
export function reachIsPending(reach: StayReach | undefined): boolean {
	return reach !== undefined && REACH_MODES.some((mode) => reach[mode].kind === 'pending');
}

/**
 * Every mode's answer in words, for the one surface with room to print all of them: the map
 * dialog's detail panel. This is the "visibly marked as not having" half of issue #405's
 * acceptance. The row shows the times a traveller can act on; the detail says what happened
 * to the modes that produced none, so a missing walk reads as "too far" rather than as the
 * app having nothing to say.
 */
export function describeModeReach(mode: ReachMode, answer: ModeReach): string {
	const word = MODE_WORD[mode];
	switch (answer.kind) {
		case 'routed':
			return `${word} ${formatDuration(answer.minutes)}`;
		case 'implausible':
			return `${word} ${formatDuration(answer.minutes)}, past the ${formatDuration(answer.limit)} this app will offer`;
		case 'too-far':
			return `${word}: ${formatDistanceKm(answer.straightLineKm)} away in a straight line, further than ${formatDuration(answer.limit)} reaches`;
		case 'no-route':
			return `${word}: no route found`;
		case 'pending':
			return `${word}: looking`;
		case 'not-asked':
			return `${word}: not looked up`;
		case 'failed':
			return `${word}: ${answer.message}`;
	}
}

export function describeStayReach(reach: StayReach | undefined): string[] {
	if (!reach) return [];
	return REACH_MODES.map((mode) => describeModeReach(mode, reach[mode]));
}

/**
 * Why a mode has no time on any row, said once above the list.
 *
 * A row that simply omits public transport reads as "there is no bus to this hostel", which
 * is a claim nobody checked. The honest version of that claim is a sentence about the list,
 * because the reason is the same for all thirty properties: OSRM answers one origin against
 * many destinations in a single request and MOTIS refuses to
 * (`api.transitous.org/api/v1/one-to-many` answers `mode TRANSIT not supported for
 * one-to-many`, measured 2026-09-06), so a bus time for thirty candidates is thirty requests
 * to a volunteer-run service. See `fetch-reach.ts` for the whole budget.
 *
 * `undefined` once at least one property has a routed transit answer, since then the absence
 * on the rows beside it is a real absence and this sentence would be describing something
 * that is no longer true.
 */
/**
 * The wording is about what a traveller can do, not about how the app fetches. An earlier
 * draft opened "routed for the whole list in two requests", which tells somebody choosing a
 * hostel nothing they can act on, and was wrong besides: `fetch-reach.ts` measured one
 * request cold on both lists it tried, because a candidate inside walking range is rare
 * enough that the foot table is usually never sent. The reason a bus time is missing belongs
 * in that file's header, where the next person to widen this will read it.
 */
export const TRANSIT_NOT_BATCHABLE_NOTE =
	'Walking and taxi times cover every stay here. A bus time is checked one stay at a time, on the transport row of the trip you pick.';

export function stayReachNote(reaches: Iterable<StayReach>): string | undefined {
	let sawTransit = false;
	let sawAnyAnswer = false;
	for (const reach of reaches) {
		if (reach.transit.kind === 'routed') sawTransit = true;
		if (reach.walk.kind !== 'not-asked' || reach.taxi.kind !== 'not-asked') sawAnyAnswer = true;
	}
	if (sawTransit || !sawAnyAnswer) return undefined;
	return TRANSIT_NOT_BATCHABLE_NOTE;
}
