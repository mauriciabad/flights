/**
 * Whether a female-only dorm can be booked as THIS itinerary's one stay, given the
 * group's traveller and female-traveller counts (domain/search-query.ts `travellers` /
 * `females`).
 *
 * The rule this exists to enforce, from issue #27: "A group with no female travellers
 * must NEVER be shown a female-only dorm price as its cheapest option." Quoting one
 * because it looked cheapest, when part or all of the group cannot legally sleep there,
 * produces a total the group cannot actually achieve - the one thing this app promises
 * never to do (AGENTS.md: "never present an estimate as a fact").
 *
 * The domain model makes the mixed-group case a hard boundary, not just an inconvenient
 * one: `Itinerary.stay` (domain/itinerary.ts) is a single `Stay` for the whole group,
 * with no way to book two room kinds for one connection. So a female-only dorm can only
 * ever be that one stay when it actually fits everyone - it cannot be "70% correct" for
 * a group of mixed gender. Splitting a group across two bookings for one connection
 * would need a different Itinerary shape entirely, which is issue #13/#1's model to
 * change, not this picker's.
 */

import { DEFAULT_TRAVELLERS } from '$lib/domain';

export type FemaleDormFit = 'all' | 'some' | 'none' | 'unspecified';

/**
 * - `'none'` (`females === 0`): the hard rule above. Never selectable, never the
 *   cheapest total.
 * - `'some'` (`0 < females < travellers`): a female-only dorm covers part of the group
 *   and not the rest. There is no domain way to price "some of us here, some of us
 *   elsewhere" as one stay, so this is treated the same as `'none'` for selection
 *   purposes - not silently priced as if it covered everyone, and not silently priced
 *   as if it covered no one either. The picker says which, in `femaleDormFitMessage`.
 * - `'unspecified'` (`females === undefined`): search-query.ts's own words - "absent
 *   means 'do not filter by female-only dorm availability', which is not the same thing
 *   as 0." Treated as selectable per that documented default. The picker still names
 *   this assumption (`femaleDormFitMessage`) rather than presenting it as a confirmed
 *   fit indistinguishable from `'all'`.
 * - `'all'` (`females >= travellers`): the whole party is female, so a female-only dorm
 *   is exactly as usable as any other room kind.
 */
export function femaleDormFit(travellers: number | undefined, females: number | undefined): FemaleDormFit {
	const travellerCount = travellers ?? DEFAULT_TRAVELLERS;
	if (females === undefined) return 'unspecified';
	if (females <= 0) return 'none';
	if (females >= travellerCount) return 'all';
	return 'some';
}

/** Whether a female-only dorm at this fit can be the group's one itinerary stay. */
export function isFemaleDormSelectable(fit: FemaleDormFit): boolean {
	return fit === 'all' || fit === 'unspecified';
}

/** User-facing copy for why a female-only dorm is, or is not, this group's stay -
 * `undefined` for `'all'`, since a fully-eligible option needs no caveat. Every other
 * case states the assumption or the shortfall plainly rather than leaving the picker to
 * imply a female-only dorm was silently checked and found fine. */
export function femaleDormFitMessage(
	fit: FemaleDormFit,
	travellers: number | undefined,
	females: number | undefined
): string | undefined {
	const travellerCount = travellers ?? DEFAULT_TRAVELLERS;
	switch (fit) {
		case 'none':
			return 'Not bookable for this group: no female travellers to use a female-only dorm.';
		case 'some':
			return `Covers ${females} of ${travellerCount} travellers only - the rest need a different room, so this can't be one stay yet.`;
		case 'unspecified':
			return 'Assumed available: no gender breakdown was given for this search.';
		case 'all':
			return undefined;
	}
}
