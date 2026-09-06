/**
 * What the traveller decided about one result, and what the app is allowed to move when
 * they change the stopover's length.
 *
 * ## Why the decisions cannot live on the draft
 *
 * `ItineraryDraft` holds what the app computed. Changing the nights throws that draft away
 * and builds a new one from the pipeline's pairing at the new length, because a pairing's
 * nights are its two flights and every pick made against the old pair was for a trip that
 * no longer exists. Anything the person chose therefore has to live where the rebuild
 * cannot reach it, which is here.
 *
 * ## A field being present IS the pin
 *
 * Issue #367 asked for a lock toggle on the days picker and invited an inversion. This is
 * the inversion. A toggle should take effect the moment you touch it and this one would
 * not; an off-by-default guard guards nobody, since a default decides the outcome for
 * nearly everyone; and forgetting a mode that protects your work is how you lose it.
 *
 * The precedent that fits is HTML's own input dirty value flag: a system default
 * overwrites the field only while the user has not touched it. So there is no lock
 * control. The bed follows the recommendation until the traveller picks one, and from then
 * on it is theirs, and the panel says which of those two is true.
 */

import type { Duration, Itinerary, Stay } from '$lib/domain';
import { recomputeItineraryWaitingTimes } from '$lib/algorithm/build';
import { isSameProperty, recommendedStay } from '$lib/stays';
import type { StopoverForRanking } from '$lib/stays';

/** One result's decisions. Every field is absent until the traveller makes that decision,
 * and absent means "whatever the app recommends". */
export interface TravellerChoices {
	nights?: number;
	/**
	 * Issue #387: which day this trip leaves, `YYYY-MM-DD` in the origin airport's own
	 * calendar.
	 *
	 * The second axis of a stopover's pairings, and a pin for the same reason `nights` is:
	 * every snapshot rebuilds every group, so a date held anywhere else would be lost the
	 * moment an unrelated provider answered. A date this connection cannot do resolves back
	 * to the pairing the card would have opened on, and the pin stays recorded rather than
	 * being quietly rewritten to something the traveller did not ask for.
	 */
	departureDate?: string;
	stay?: Stay;
	originWaitingTime?: Duration;
	connectionWaitingTime?: Duration;
}

export type TravellerChoicesByResult = Readonly<Record<string, TravellerChoices>>;

/**
 * Merges one gesture into the record, keyed by result id.
 *
 * A field passed as `undefined` is forgotten rather than stored, which is how "use the
 * recommended bed" hands the bed back to the app: there is no third state between chosen
 * and not, so un-choosing has to remove the field. A result left with no decisions at all
 * drops out entirely, so the record only ever names results somebody has touched.
 */
export function recordChoice(
	all: TravellerChoicesByResult,
	id: string,
	choice: Partial<TravellerChoices>
): TravellerChoicesByResult {
	const merged: TravellerChoices = { ...all[id], ...choice };
	for (const field of Object.keys(choice) as (keyof TravellerChoices)[]) {
		if (choice[field] === undefined) delete merged[field];
	}
	const next: Record<string, TravellerChoices> = { ...all };
	if (Object.keys(merged).length === 0) delete next[id];
	else next[id] = merged;
	return next;
}

/** A bed the app moved on the traveller's behalf, held until they answer it. Never
 * produced for a bed they chose, because that one does not move. */
export interface AutomaticStaySwap {
	from: Stay;
	to: Stay;
	/** The length that moved it, so the notice can say what caused the change. */
	nights: number;
}

export interface BedForLength {
	/** The bed this trip should book. `undefined` when nothing here is bookable by this
	 * group, the same answer the picker's own empty state prints. */
	stay?: Stay;
	/** Set only when this call moved a recommended bed to a different property. */
	swap?: AutomaticStaySwap;
}

/**
 * Which bed a stopover should hold once its length has changed, and whether that is news.
 *
 * More nights is more free time, and free time is what makes a central bed worth paying
 * for, so the ranking's answer at four nights is often not its answer at one. Re-ranking
 * here is what turns that into the trip the traveller is looking at rather than a list
 * that re-sorts under a bed which never moves.
 *
 * Ranked exactly once per call. The bed and the free-time window depend on each other (the
 * journey to a bed narrows the window that ranks the bed), so a second pass on the result
 * of the first would be a loop with no fixed point worth reaching.
 */
export function bedForLength(input: {
	/** The bed on screen before this change, which is what a swap is measured from. */
	previous: Stay | undefined;
	/** `TravellerChoices.stay`. Present means the traveller owns this one. */
	chosen: Stay | undefined;
	candidates: readonly Stay[];
	/** Absent while this connection's airport has not arrived, which leaves nothing to
	 * measure a property against. A pin is still honoured; nothing is re-ranked. */
	stopover: StopoverForRanking | undefined;
}): BedForLength {
	const { previous, chosen, candidates, stopover } = input;
	if (chosen) return { stay: chosen };
	if (!stopover) return {};

	const stay = recommendedStay(candidates, stopover);
	if (!stay || !previous || isSameProperty(previous.property, stay.property)) return { stay };
	return { stay, swap: { from: previous, to: stay, nights: stopover.nights } };
}

export type StaySwapsByResult = Readonly<Record<string, AutomaticStaySwap>>;

/** `undefined` is a real argument here rather than a second function: a swap is recorded
 * and retired from the same two places, and splitting them invites one of the two to be
 * forgotten. */
export function recordStaySwap(
	all: StaySwapsByResult,
	id: string,
	swap: AutomaticStaySwap | undefined
): StaySwapsByResult {
	const next: Record<string, AutomaticStaySwap> = { ...all };
	if (swap) next[id] = swap;
	else delete next[id];
	return next;
}

/**
 * The traveller's own airport buffers, put back on a trip that was rebuilt without them.
 *
 * This fixes a loss of work that predates issue #367. Changing the nights replaces the
 * whole draft, and a waiting time edited with the stepper lived only on that draft, so
 * anyone who set their airport buffer and then pressed the nights ladder silently got the
 * app's number back. It was the only edit that behaved that way, because `setWaitingTime`
 * deliberately bypasses `draft.apply` (issue #135: a longer wait does not invalidate a
 * timetable) and so left nothing behind that a rebuild could carry.
 *
 * The connection buffer is clamped to what the new pairing can give it, which is the same
 * ceiling the stepper enforces: every minute of that buffer is a minute free time gives
 * up, both carved from one fixed layover. Without the clamp, six hours pinned on a long
 * stopover would be re-applied to a four-hour layover and take the free time negative.
 */
export function reapplyWaitingTimes(itinerary: Itinerary, choices: TravellerChoices): Itinerary {
	const ceiling = itinerary.connectionWaitingTime + itinerary.freeTime.duration;
	const connectionWaitingTime =
		choices.connectionWaitingTime === undefined
			? undefined
			: (Math.min(choices.connectionWaitingTime, ceiling) as Duration);
	return recomputeItineraryWaitingTimes(itinerary, {
		originWaitingTime: choices.originWaitingTime,
		connectionWaitingTime
	});
}
