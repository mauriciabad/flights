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

import type { Duration, Stay } from '$lib/domain';
import { isSameProperty, recommendedStay } from '$lib/stays';
import type { StopoverForRanking } from '$lib/stays';

/** One result's decisions. Every field is absent until the traveller makes that decision,
 * and absent means "whatever the app recommends". */
export interface TravellerChoices {
	nights?: number;
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
	stopover: StopoverForRanking;
}): BedForLength {
	const { previous, chosen, candidates, stopover } = input;
	if (chosen) return { stay: chosen };

	const stay = recommendedStay(candidates, stopover);
	if (!stay || !previous || isSameProperty(previous.property, stay.property)) return { stay };
	return { stay, swap: { from: previous, to: stay, nights: stopover.nights } };
}
