/**
 * Issue #135: what moment a public-transport lookup was planned for.
 *
 * Until this existed, a transit `Transfer` carried a departure list and nothing that said
 * which journey it belonged to, so the app shipped a Thursday-lunchtime Barcelona timetable
 * as the plan for a 06:15 Sunday check-in. A schedule with no stated moment is not a
 * schedule, it is a coincidence, which is why `TransitSchedule.plannedFor` is required.
 *
 * Reading one of these — "is this the last bus, and what does missing it cost" — is
 * `algorithm/transit-schedule.ts`'s job, since it needs this directory's own header rule
 * kept: types and constants here, no logic.
 */

import type { LocalDateTime } from './datetime';

/**
 * The journey moment a transit lookup was planned for, as a local wall clock plus its
 * offset (AGENTS.md "Timezones") rather than a bare UTC instant. Which of the two kinds it
 * is changes the whole question being asked, so it is a field rather than something a
 * reader has to infer from the leg's position in the trip.
 */
export interface TransitPlanMoment {
	time: LocalDateTime;
	/**
	 * `true`: `time` is the latest acceptable ARRIVAL — a check-in deadline. The useful
	 * answer is the last departure that still makes it, and by construction nothing later
	 * does.
	 *
	 * `false`: `time` is the earliest possible DEPARTURE — the moment the traveller is free
	 * to leave, e.g. a landing plus the walk out of the terminal. The useful answer is the
	 * first departure at or after it, plus the ones behind it.
	 */
	arriveBy: boolean;
}

/**
 * Issue #8 ("the last bus problem") and brief line 84 ("next schedules in case of missing
 * it"), with issue #135's addition of *which* journey the times belong to.
 */
export interface TransitSchedule {
	/** The departure the traveller is being told to catch. */
	intended: LocalDateTime;
	/** When `intended` gets them there. */
	arrival?: LocalDateTime;
	/**
	 * Departures strictly after `intended`, ascending. Empty means the provider found
	 * nothing later — data to show, never an error (domain/transfer.ts).
	 *
	 * On an `arriveBy` plan this list is always empty by construction: every itinerary the
	 * planner returned arrives before the deadline, so there is no later one to list. That
	 * is not silence about "what if I miss it" — it is the answer. See `earlier` below for
	 * what the traveller can actually choose between.
	 */
	following: LocalDateTime[];
	/**
	 * Only on an `arriveBy` plan: the departures BEFORE `intended` that still arrive in
	 * time, ascending. These are the traveller's safety margin, not alternatives after the
	 * fact.
	 */
	earlier?: LocalDateTime[];
	plannedFor: TransitPlanMoment;
}
