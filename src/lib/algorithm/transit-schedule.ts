/**
 * Issue #135, second half: reading a `TransitSchedule` for the one question the brief asks
 * (line 84, "next schedules in case of missing it") and the app has never been able to
 * answer — what happens if you miss the last one.
 *
 * Pure, and the single implementation: the timeline and the transport picker both call it,
 * so the card and the picker can never disagree about whether the 00:10 bus is the last one.
 */

import { minutesBetween } from './build';
import type { Duration, LocalDateTime, TransitSchedule } from '../domain';

/**
 * A wait longer than this stops being "you would have waited for a bus anyway" and starts
 * being a decision — take the taxi, or plan the evening around it. Half an hour is the
 * point at which an urban headway (typically 10 to 20 minutes) has clearly stopped, which
 * is the fact the traveller is actually looking for.
 */
export const NEXT_SERVICE_SOON_MINUTES = 30 as Duration;

/**
 * - `'another-soon'`: another one follows within `NEXT_SERVICE_SOON_MINUTES`. Missing it
 *   costs a wait, not the trip.
 * - `'long-gap'`: the next one exists but is far enough out to change the plan. `gap` and
 *   `next` carry the numbers.
 * - `'last-known'`: the planner found nothing later at all. Rendered as "nothing later was
 *   found", never as "there is no later bus" — the two are different claims and only the
 *   first one was observed (AGENTS.md: "show the error you got, never the one you assumed").
 * - `'last-in-time'`: an `arriveBy` plan. Later departures may well exist; none of them
 *   arrives before the deadline, so missing this one means missing the flight.
 */
export type MissedServiceOutcome = 'another-soon' | 'long-gap' | 'last-known' | 'last-in-time';

export interface MissedService {
	outcome: MissedServiceOutcome;
	/** The departure after `intended`, when one is known. */
	next?: LocalDateTime;
	/** Minutes from `intended` to `next`, when both are known. */
	gap?: Duration;
}

export function readMissedService(schedule: TransitSchedule): MissedService {
	if (schedule.plannedFor.arriveBy) return { outcome: 'last-in-time' };

	const next = schedule.following[0];
	if (!next) return { outcome: 'last-known' };

	const gap = minutesBetween(schedule.intended, next);
	return { outcome: gap > NEXT_SERVICE_SOON_MINUTES ? 'long-gap' : 'another-soon', next, gap };
}
