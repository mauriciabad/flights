/**
 * Whether a gender-restricted room can be booked as THIS itinerary's one stay, given the
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
 * with no way to book two room kinds for one connection. So a restricted dorm can only
 * ever be that one stay when it actually fits everyone - it cannot be "70% correct" for
 * a group of mixed gender. Splitting a group across two bookings for one connection
 * would need a different Itinerary shape entirely, which is issue #13/#1's model to
 * change, not this picker's.
 *
 * This file was `female-dorm-fit.ts` until issue #288. It answers the same question about
 * a men-only room now, because Hostelworld sells those too and the old code classified
 * them as ordinary dorms - so a female traveller was being offered a bed she cannot book,
 * which is issue #27's complaint with the genders swapped. One module rather than a
 * mirrored pair, so the two rules cannot drift.
 */

import { DEFAULT_TRAVELLERS, type Stay } from "$lib/domain";

/** Who a room admits, when it does not admit everybody. */
export type RoomGenderRestriction = "female" | "male";

export type GenderFit = "all" | "some" | "none" | "unspecified";

/**
 * Who this stay is restricted to, or `undefined` when anyone in the party can sleep there.
 *
 * Both the room-level restrictions and the property-wide one land here. `Property.womenOnly`
 * is the second: "Hostelle - women only hostel London" passed through as an ordinary
 * `dorm` because both mappers classified a room by its own NAME and nothing read the
 * property. The owner found it recommended to a party with no female travellers, and said
 * "it seems that it is being ignored because i cant go there".
 *
 * Every caller that gates selection asks here, so a new restriction only has to be taught
 * to one function.
 */
export function stayRestrictedTo(stay: Stay): RoomGenderRestriction | undefined {
  if (stay.roomKind === "male-dorm") return "male";
  if (stay.roomKind === "female-dorm" || stay.property.womenOnly === true) {
    return "female";
  }
  return undefined;
}

/**
 * How much of the group a restricted room covers.
 *
 * - `'none'`: nobody in the party is of the admitted gender. The hard rule above. Never
 *   selectable, never the cheapest total.
 * - `'some'`: the room covers part of the group and not the rest. There is no domain way
 *   to price "some of us here, some of us elsewhere" as one stay, so this is treated the
 *   same as `'none'` for selection purposes - not silently priced as if it covered
 *   everyone, and not silently priced as if it covered no one either. The picker says
 *   which, in `genderFitMessage`.
 * - `'unspecified'` (`females === undefined`): search-query.ts's own words - "absent
 *   means 'do not filter by female-only dorm availability', which is not the same thing
 *   as 0." Treated as selectable per that documented default. The picker still names this
 *   assumption rather than presenting it as a confirmed fit indistinguishable from
 *   `'all'`. It is a statement about what the SEARCH left out, not about what the provider
 *   left out - the room's own restriction is known either way.
 * - `'all'`: every traveller is of the admitted gender, so the room is exactly as usable
 *   as any other kind. An unrestricted room is always `'all'`.
 */
export function genderFit(
  restrictedTo: RoomGenderRestriction | undefined,
  travellers: number | undefined,
  females: number | undefined,
): GenderFit {
  if (restrictedTo === undefined) return "all";
  if (females === undefined) return "unspecified";
  const travellerCount = travellers ?? DEFAULT_TRAVELLERS;
  const admitted = admittedTravellers(restrictedTo, travellerCount, females);
  if (admitted <= 0) return "none";
  if (admitted >= travellerCount) return "all";
  return "some";
}

/** How many of the party this room admits. Clamped at both ends, because a `females`
 * above the party size is a typo rather than a party with negative men in it. */
function admittedTravellers(
  restrictedTo: RoomGenderRestriction,
  travellers: number,
  females: number,
): number {
  return restrictedTo === "female"
    ? Math.min(females, travellers)
    : Math.max(travellers - females, 0);
}

/** Whether a room at this fit can be the group's one itinerary stay. */
export function isGenderFitSelectable(fit: GenderFit): boolean {
  return fit === "all" || fit === "unspecified";
}

/** How much of the group this particular stay covers - the two steps above in the order
 * every caller wants them. */
export function stayGenderFit(
  stay: Stay,
  travellers: number | undefined,
  females: number | undefined,
): GenderFit {
  return genderFit(stayRestrictedTo(stay), travellers, females);
}

/** Whether this stay can be the whole party's one stay. */
export function isStayBookableByGroup(
  stay: Stay,
  travellers: number | undefined,
  females: number | undefined,
): boolean {
  return isGenderFitSelectable(stayGenderFit(stay, travellers, females));
}

/**
 * User-facing copy for why a gender-restricted room is, or is not, this group's stay -
 * `undefined` for `'all'` and for an unrestricted room, since neither needs a caveat.
 * Every other case states the assumption or the shortfall plainly rather than leaving the
 * picker to imply a restricted room was silently checked and found fine.
 */
export function genderFitMessage(
  restrictedTo: RoomGenderRestriction | undefined,
  fit: GenderFit,
  travellers: number | undefined,
  females: number | undefined,
): string | undefined {
  if (restrictedTo === undefined) return undefined;
  const travellerCount = travellers ?? DEFAULT_TRAVELLERS;
  const who =
    restrictedTo === "female"
      ? { travellers: "female travellers", only: "women only" }
      : { travellers: "male travellers", only: "men only" };

  switch (fit) {
    case "none":
      return `Not bookable for this group: no ${who.travellers}, and this is ${who.only}.`;
    case "unspecified":
      return "Assumed available: no gender breakdown was given for this search.";
    case "some":
      return `Covers ${admittedTravellers(restrictedTo, travellerCount, females ?? 0)} of ${travellerCount} travellers only - the rest need a different room, so this can't be one stay yet.`;
    case "all":
      return undefined;
  }
}

/** `genderFitMessage` for one stay, so no caller has to pair a fit with the restriction it
 * was computed from. */
export function stayGenderFitMessage(
  stay: Stay,
  travellers: number | undefined,
  females: number | undefined,
): string | undefined {
  const restrictedTo = stayRestrictedTo(stay);
  return genderFitMessage(
    restrictedTo,
    genderFit(restrictedTo, travellers, females),
    travellers,
    females,
  );
}
