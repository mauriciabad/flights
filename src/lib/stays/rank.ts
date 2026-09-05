/**
 * Turns a flat list of candidate properties into what the picker actually needs: which
 * options a given group can book at all, and a cheapest-first ordering across
 * properties - issue #27's "Alternatives list, cheapest first."
 *
 * Issue #219 changed what "cheapest" means here, and the reason is in
 * `stopover-cost.ts`: ordering on the nightly rate alone put the walkable beds last of 33
 * and left a dorm 48.3 km out as the app's own pick. "Cheapest" is now the room for this
 * stopover's nights plus getting there and back. Within one property nothing moved -
 * every option there shares an address, so the cheapest room is still the cheapest room.
 */

import type { Coordinates } from "$lib/domain";
import { isStayBookableByGroup } from "./gendered-room-fit";
import { stopoverStayCostMinorUnits } from "./stopover-cost";
import type { PropertyStayOptions, StayOption } from "./types";

/** Whether one option can be THIS group's whole itinerary stay. An unrestricted room kind
 * is always fine; a women-only or men-only one goes through `gendered-room-fit.ts`'s rule.
 * Note this asks "can the group book this at all," not "is this row's classification
 * confirmed" - `StayOption.notStated` is a display concern (the picker still offers a
 * `not-stated` row, just without asserting a fact the source didn't give it), not an
 * eligibility one. */
export function isOptionSelectable(
  option: StayOption,
  travellers: number | undefined,
  females: number | undefined,
): boolean {
  return isStayBookableByGroup(option.stay, travellers, females);
}

/** Every option at a property this group can actually book as their one stay - excludes
 * a women-only or men-only room the group cannot fully use (issue #27's hard rule when `females`
 * is 0, and the mixed-group case besides). */
export function selectableOptions(
  property: PropertyStayOptions,
  travellers: number | undefined,
  females: number | undefined,
): StayOption[] {
  return property.options.filter((option) =>
    isOptionSelectable(option, travellers, females),
  );
}

/** The cheapest option a group can actually book at a property, or `undefined` when
 * every option there is ineligible (e.g. the only room on offer is a female-only dorm
 * and the group has no female travellers) - never a restricted room's price standing in
 * as "cheapest" for a group that cannot book it. */
export function cheapestSelectableOption(
  property: PropertyStayOptions,
  travellers: number | undefined,
  females: number | undefined,
): StayOption | undefined {
  return selectableOptions(property, travellers, females).reduce<
    StayOption | undefined
  >(
    (cheapest, option) =>
      !cheapest ||
      option.stay.pricePerNight.minorUnits <
        cheapest.stay.pricePerNight.minorUnits
        ? option
        : cheapest,
    undefined,
  );
}

/** Properties ranked cheapest-first by what this group can actually book there, where
 * cheapest is the whole cost of the stopover's stay: the nights, plus the round trip out
 * to the property (`stopover-cost.ts`). A
 * property with no selectable option (every room is a restricted dorm this group can't
 * use) sorts last rather than being dropped outright, so it stays visible with an
 * explanation instead of quietly disappearing. Stable for ties and for two ineligible
 * properties (both keep their input order), since `Array.prototype.sort` in every
 * engine this app targets is a stable sort. */
export interface StopoverForRanking {
  travellers: number | undefined;
  females: number | undefined;
  /** Where both ground legs begin and end, so a property's distance can be priced. */
  connectionAirport: Coordinates;
  /** `Itinerary.nightsInConnection` for the trip on screen. The picker always knows it,
   * and it is what decides whether a cheap bed across town has enough nights to pay for
   * the journey out to it. */
  nights: number;
}

export function rankProperties<T extends PropertyStayOptions>(
  properties: readonly T[],
  stopover: StopoverForRanking,
): T[] {
  const { travellers, females } = stopover;
  return [...properties].sort((a, b) => {
    const cheapestA = cheapestSelectableOption(a, travellers, females);
    const cheapestB = cheapestSelectableOption(b, travellers, females);
    if (!cheapestA && !cheapestB) return 0;
    if (!cheapestA) return 1;
    if (!cheapestB) return -1;
    return (
      stopoverStayCostMinorUnits(cheapestA.stay, stopover.connectionAirport, stopover.nights) -
      stopoverStayCostMinorUnits(cheapestB.stay, stopover.connectionAirport, stopover.nights)
    );
  });
}
