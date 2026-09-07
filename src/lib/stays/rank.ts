/**
 * Turns a flat list of candidate properties into what the picker actually needs: which
 * options a given group can book at all, and a cheapest-first ordering across
 * properties - issue #27's "Alternatives list, cheapest first."
 *
 * Issue #219 changed what "cheapest" means here, and the reason is in
 * `stopover-cost.ts`: ordering on the nightly rate alone put the walkable beds last of 33
 * and left a dorm 48.3 km out as the app's own pick. "Cheapest" is now the room for this
 * stopover's nights, plus the journeys the stopover makes out of it. Within one property
 * nothing moved - every option there shares an address, so the cheapest room is still the
 * cheapest room.
 */

import type { Coordinates } from "$lib/domain";
import { isStayBookableByGroup } from "./gendered-room-fit";
import { allowsBedKind, bedKindOf, type BedKind } from "./room-kind";
import { stopoverStayCostMinorUnits } from "./stopover-cost";
import type { PropertyStayOptions, StayOption } from "./types";

/**
 * Whether one option can be THIS group's whole itinerary stay. An unrestricted room kind
 * is always fine; a women-only or men-only one goes through `gendered-room-fit.ts`'s rule.
 *
 * Issue #423's bed-kind filter is AND-ed onto that, at this seam and not further down the
 * pipeline, because a `StayChoice` has already resolved a property to one option. Filtering
 * finished choices on `cheapest.stay.roomKind` would drop a hostel with a EUR 13.00 dorm and
 * a EUR 40.00 private room from a private-room search, on the strength of a dorm the
 * traveller had just asked not to see. Narrowing the pool first makes that unrepresentable:
 * the same property resolves to its private room instead.
 *
 * `bedKinds` never overrides the gender rule and never widens it. Empty is every kind.
 */
export function isOptionSelectable(
  option: StayOption,
  travellers: number | undefined,
  females: number | undefined,
  bedKinds?: ReadonlySet<BedKind>,
): boolean {
  return (
    allowsBedKind(bedKinds, option.stay.roomKind) &&
    isStayBookableByGroup(option.stay, travellers, females)
  );
}

/** Every option at a property this group can actually book as their one stay - excludes
 * a women-only or men-only room the group cannot fully use (issue #27's hard rule when `females`
 * is 0, and the mixed-group case besides), and anything outside `bedKinds` when the traveller
 * has narrowed to one (issue #423). */
export function selectableOptions(
  property: PropertyStayOptions,
  travellers: number | undefined,
  females: number | undefined,
  bedKinds?: ReadonlySet<BedKind>,
): StayOption[] {
  return property.options.filter((option) =>
    isOptionSelectable(option, travellers, females, bedKinds),
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
  bedKinds?: ReadonlySet<BedKind>,
): StayOption | undefined {
  return selectableOptions(property, travellers, females, bedKinds).reduce<
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
 * cheapest is the whole cost of the stopover's stay: the nights, the round trip out to the
 * property, and a round trip into the city centre for each day the traveller can spend
 * there (`stopover-cost.ts`). The ordering weighs the nights and the days out at once, and
 * those two pull opposite ways, so extending a stopover moves the list toward the centre as
 * well as toward the cheap bed across town.
 *
 * A property with no selectable option (every room is a restricted dorm this group can't
 * use) sorts last rather than being dropped outright, so it stays visible with an
 * explanation instead of quietly disappearing. Stable for ties and for two ineligible
 * properties (both keep their input order), since `Array.prototype.sort` in every
 * engine this app targets is a stable sort. */
export interface StopoverForRanking {
  travellers: number | undefined;
  females: number | undefined;
  /** Where both airport legs begin and end, so a property's distance can be priced. */
  connectionAirport: Coordinates;
  /** The stopover city's own centre, and `undefined` when the airport has no city point
   * to offer. Absent costs the day trips nothing rather than standing the runway in for
   * the city, which `stopover-cost.ts` and `domain/airport.ts` both refuse to do. */
  cityCentre?: Coordinates;
  /** `Itinerary.nightsInConnection` for the trip on screen. The picker always knows it,
   * and it is what decides whether a cheap bed across town has enough nights to pay for
   * the journey out to it. */
  nights: number;
  /** Days of that trip the traveller can actually spend in the city. Each one is a round
   * trip into the centre, which is what decides whether a bed near the cathedral has
   * enough days to pay for its nightly premium. */
  visitDays: number;
  /**
   * The bed kinds the traveller has narrowed to (issue #423), empty or absent meaning all
   * of them. Here beside `travellers` and `females` because it is the same category of
   * thing: a constraint on which options count, applied before anything is priced or
   * ordered. A property is ranked by the cheapest room it offers WITHIN this, so narrowing
   * to private rooms reorders the list on private-room prices rather than reordering it on
   * dorm prices and then hiding rows.
   */
  bedKinds?: ReadonlySet<BedKind>;
}

export function rankProperties<T extends PropertyStayOptions>(
  properties: readonly T[],
  stopover: StopoverForRanking,
): T[] {
  const { travellers, females, bedKinds } = stopover;
  return [...properties].sort((a, b) => {
    const cheapestA = cheapestSelectableOption(a, travellers, females, bedKinds);
    const cheapestB = cheapestSelectableOption(b, travellers, females, bedKinds);
    if (!cheapestA && !cheapestB) return 0;
    if (!cheapestA) return 1;
    if (!cheapestB) return -1;
    return (
      stopoverStayCostMinorUnits(cheapestA.stay, stopover) -
      stopoverStayCostMinorUnits(cheapestB.stay, stopover)
    );
  });
}

/**
 * Whether a property belongs in a list the traveller has narrowed to `bedKinds`.
 *
 * Two properties can have nothing this group can book, and they are not the same thing.
 * One the group cannot book at all - every room is a women-only or men-only dorm - and it
 * stays on the list carrying that reason, because no click of theirs changes it. The other
 * has a bed they could book in a kind they asked not to see, and showing that row is showing
 * them what they just asked to hide.
 *
 * So the second test is deliberately about the UNfiltered pool: empty there means the group
 * is the reason, and the row survives.
 */
export function isPropertyOnOffer(
  property: PropertyStayOptions,
  travellers: number | undefined,
  females: number | undefined,
  bedKinds?: ReadonlySet<BedKind>,
): boolean {
  if (selectableOptions(property, travellers, females, bedKinds).length > 0) {
    return true;
  }
  return selectableOptions(property, travellers, females).length === 0;
}

/**
 * How many properties offer a bed of each kind this group can actually book, which is what
 * the picker's two chips print.
 *
 * Gender fit is applied and the bed-kind filter is not, on purpose: a count that moved as
 * the traveller clicked would be counting its own answer, and the number they need is how
 * much inventory the OTHER chip has. Counted over every candidate property, including the
 * one whose card is open, since that one is a stay near this connection too.
 */
export function countPropertiesByBedKind(
  properties: readonly PropertyStayOptions[],
  travellers: number | undefined,
  females: number | undefined,
): Record<BedKind, number> {
  const counts: Record<BedKind, number> = { dorm: 0, private: 0 };
  for (const property of properties) {
    const kinds = new Set(
      selectableOptions(property, travellers, females).map((option) =>
        bedKindOf(option.stay.roomKind),
      ),
    );
    for (const kind of kinds) counts[kind] += 1;
  }
  return counts;
}
