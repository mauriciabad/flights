/**
 * Issue #135, second half: reading a `TransitSchedule` for the one question the brief asks
 * (line 84, "next schedules in case of missing it") and the app has never been able to
 * answer — what happens if you miss the last one.
 *
 * Pure, and the single implementation: the timeline and the transport picker both call it,
 * so the card and the picker can never disagree about whether the 00:10 bus is the last one.
 */

import { addLocalMinutes, minutesBetween, type ItineraryParts } from './build';
import type { Duration, LocalDateTime, TransitLegField, TransitPlanMoment, TransitSchedule } from '../domain';

/**
 * A wait longer than this stops being "you would have waited for a bus anyway" and starts
 * being a decision — take the taxi, or plan the evening around it. Half an hour is the
 * point at which an urban headway (typically 10 to 20 minutes) has clearly stopped, which
 * is the fact the traveller is actually looking for.
 */
export const NEXT_SERVICE_SOON_MINUTES = 30 as Duration;

/**
 * A wait before the FIRST departure under this is one the traveller would have had
 * whatever their flight did, rather than a dead spot in the timetable. Twenty minutes,
 * which is a headway; `NEXT_SERVICE_SOON_MINUTES` above is thirty, because these two
 * measure different things. This one asks whether the service is running at all at the
 * hour you arrive. That one asks what missing a running service costs.
 *
 * Lived in `TransportPicker` until issue #344 gave the timeline the same sentence. Two
 * surfaces disagreeing about what counts as a dead spot is the drift `readMissedService`
 * is one function for.
 */
export const NORMAL_WAIT_THRESHOLD_MINUTES = 20 as Duration;

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

/**
 * The moment a leg's transit lookup is planned for, read off the trip as it stands now.
 *
 * The two `arriveBy` legs are deadlines to be at a gate, so the moment is the flight's
 * departure minus the pre-boarding buffer the traveller chose. Both are on the itinerary,
 * which is what lets `readStaleSchedule` below answer with no history at all.
 *
 * The two runway legs are the opposite: the traveller is free from the landing plus that
 * airport's walk-out time. The landing is on the itinerary; the walk-out time is on the
 * transfer, because `applyLandingBuffer` records the minutes it adds instead of only
 * spending them on the duration. That was issue #266's second half, and recording the
 * number is the whole fix. It makes the moment derivable here rather than something a
 * recompute has to carry forward, so a runway leg heals itself exactly the way a deadline
 * leg does.
 *
 * `undefined` for a runway leg whose transfer never went through `applyLandingBuffer`.
 * Nothing says how long that airport takes to walk out of, and inventing a number would
 * put a made-up moment in front of a traveller.
 *
 * The single derivation of these moments: `search/transit-schedule.ts`'s `planTransitLegs`
 * asks the same question before a lookup, and asks it here. It cannot ask about the two
 * runway legs, since at that point there is no answered transfer to read a buffer off, so
 * it passes the airports' own buffers in and this reads them back afterwards.
 */
export function transitLegMoment(parts: ItineraryParts, field: TransitLegField): TransitPlanMoment | undefined {
	if (field === 'transferToOriginAirport') {
		return { time: addLocalMinutes(parts.outboundFlight.departure, -parts.originWaitingTime), arriveBy: true };
	}
	if (field === 'transferToConnectionAirport') {
		return { time: addLocalMinutes(parts.onwardFlight.departure, -parts.connectionWaitingTime), arriveBy: true };
	}
	// Each runway leg reads its OWN flight: the hotel-bound one starts at the connection
	// landing, the destination one at the onward landing. A swap of one flight must not
	// discredit the timetable that belongs to the other.
	const landing =
		field === 'transferToHotel' ? parts.outboundFlight.arrival : parts.onwardFlight.arrival;
	const buffer = parts[field]?.landingBuffer;
	if (buffer === undefined) return undefined;
	return { time: addLocalMinutes(landing, buffer), arriveBy: false };
}

/**
 * How long after landing this leg's first departure actually is. Issue #344.
 *
 * The owner: "if the flight is at 5am, arriving at 3am in some places changes the
 * transport options, the metro may be closed and a night bus needed." The app has known
 * this number since #135 taught it to ask the timetable about the real journey moment, and
 * only the transport picker ever said it out loud. A results card could print `5:49am`
 * beside a bus for a traveller who lands at 8:30pm the night before, with nothing on the
 * row naming the nine hours in between.
 *
 * Measured from the landing rather than from `transitLegMoment`'s landing-plus-walk-out,
 * because that is the anchor the picker's own sentence uses ("4h 20m after you land") and
 * one wait described by two numbers on two screens is worse than either number alone.
 *
 * `undefined` for the two legs that end at a gate, which have no wait of this kind: an
 * `arriveBy` answer is a departure chosen backwards from a deadline, and the traveller
 * leaves when it leaves. Also `undefined` for a leg with no timetable at all, which is
 * every road leg.
 */
export function transitDepartureWait(parts: ItineraryParts, field: TransitLegField): Duration | undefined {
	const schedule = parts[field]?.transitSchedule;
	if (!schedule) return undefined;
	// The same split `transitLegMoment` makes above, and for the same reason: which flight a
	// leg hangs off is knowledge this module owns.
	if (field !== 'transferToHotel' && field !== 'transferToDestinationLocation') return undefined;
	const landing =
		field === 'transferToHotel' ? parts.outboundFlight.arrival : parts.onwardFlight.arrival;
	return Math.max(0, minutesBetween(landing, schedule.intended)) as Duration;
}

/**
 * Issue #266: the moment this leg happens at NOW, when the timetable stored on it was
 * planned for a different one. `undefined` means the schedule still describes the trip on
 * screen, and every caller may print its departures as fact.
 *
 * A traveller who pushes the connection wait from 2h to 700m moves the deadline eleven
 * hours earlier, and the row went on reading "Last departure that still gets you there by
 * 1:20pm" — a real sentence about a real timetable, for a trip nobody is taking any more.
 * A flight swap does the same to the two runway legs from the other end, moving the
 * landing the ride into town starts from.
 *
 * Derived rather than flagged, so it clears itself: drag the wait back to 2h and the two
 * moments agree again, with nothing to reset. Wall clocks are compared, not instants,
 * because the airport and its zone are the one thing a waiting-time edit cannot move.
 */
export function readStaleSchedule(parts: ItineraryParts, field: TransitLegField): LocalDateTime | undefined {
	const plannedFor = parts[field]?.transitSchedule?.plannedFor;
	const now = transitLegMoment(parts, field);
	if (!plannedFor || !now) return undefined;
	return now.time.local === plannedFor.time.local ? undefined : now.time;
}
