/**
 * Turns a flat list of candidate properties into what the picker actually needs: which
 * options a given group can book at all, and a cheapest-first ordering across
 * properties - issue #27's "Alternatives list, cheapest first."
 */

import { femaleDormFit, isFemaleDormSelectable } from './female-dorm-fit';
import type { PropertyStayOptions, StayOption } from './types';

/** Whether one option can be THIS group's whole itinerary stay. Every non-female-only
 * room kind is always fine; a female-only dorm goes through `female-dorm-fit.ts`'s rule.
 * Note this asks "can the group book this at all," not "is this row's classification
 * confirmed" - `StayOption.notStated` is a display concern (the picker still offers a
 * `not-stated` row, just without asserting a fact the source didn't give it), not an
 * eligibility one. */
export function isOptionSelectable(
	option: StayOption,
	travellers: number | undefined,
	females: number | undefined
): boolean {
	if (option.stay.roomKind !== 'female-dorm') return true;
	return isFemaleDormSelectable(femaleDormFit(travellers, females));
}

/** Every option at a property this group can actually book as their one stay - excludes
 * a female-only dorm the group cannot fully use (issue #27's hard rule when `females`
 * is 0, and the mixed-group case besides). */
export function selectableOptions(
	property: PropertyStayOptions,
	travellers: number | undefined,
	females: number | undefined
): StayOption[] {
	return property.options.filter((option) => isOptionSelectable(option, travellers, females));
}

/** The cheapest option a group can actually book at a property, or `undefined` when
 * every option there is ineligible (e.g. the only room on offer is a female-only dorm
 * and the group has no female travellers) - never a female-only dorm price standing in
 * as "cheapest" for a group that cannot book it. */
export function cheapestSelectableOption(
	property: PropertyStayOptions,
	travellers: number | undefined,
	females: number | undefined
): StayOption | undefined {
	return selectableOptions(property, travellers, females).reduce<StayOption | undefined>(
		(cheapest, option) =>
			!cheapest || option.stay.pricePerNight.minorUnits < cheapest.stay.pricePerNight.minorUnits
				? option
				: cheapest,
		undefined
	);
}

/** Properties ranked cheapest-first by what this group can actually book there. A
 * property with no selectable option (every room is a female-only dorm this group can't
 * use) sorts last rather than being dropped outright, so it stays visible with an
 * explanation instead of quietly disappearing. Stable for ties and for two ineligible
 * properties (both keep their input order), since `Array.prototype.sort` in every
 * engine this app targets is a stable sort. */
export function rankProperties<T extends PropertyStayOptions>(
	properties: readonly T[],
	travellers: number | undefined,
	females: number | undefined
): T[] {
	return [...properties].sort((a, b) => {
		const cheapestA = cheapestSelectableOption(a, travellers, females);
		const cheapestB = cheapestSelectableOption(b, travellers, females);
		if (!cheapestA && !cheapestB) return 0;
		if (!cheapestA) return 1;
		if (!cheapestB) return -1;
		return cheapestA.stay.pricePerNight.minorUnits - cheapestB.stay.pricePerNight.minorUnits;
	});
}
