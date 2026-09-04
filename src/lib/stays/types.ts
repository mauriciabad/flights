/**
 * Types the stay picker (issue #27) needs beyond the shared Stay/RoomKind domain
 * (domain/stay.ts, issue #1) and the StayProvider contract (providers/types.ts, issue
 * #2). Picker-local rather than added to either shared file: issue #10's Agoda/Booking
 * adapters (PR #67) return a plain `Stay[]` for a search; grouping those into "one
 * property, its room kinds" and flagging a row the source didn't actually confirm
 * (issue #65) are both display concerns this component owns, not something every
 * StayProvider caller needs.
 *
 * AGENTS.md: "If your issue depends on something that does not exist yet, do not
 * invent a competing version of it... define the narrowest possible interface." This
 * was written before PR #67 merged, on that basis - additive on top of `Stay`, not a
 * redesign of it, and it still holds true now that the adapters are real: neither
 * `Stay`/`RoomKind` nor `StayProvider` needed to change for this picker to work.
 */

import type { Property, Stay } from '$lib/domain';

/**
 * One priced room-kind option, plus whether the source actually told us its dorm/private
 * split or its female-only status, versus that having been inferred from a room name (or
 * not determined at all). Issue #65: Booking's `is_dormitory` was never confirmed
 * against a real dorm room, and neither Agoda nor Booking exposes a confirmed
 * female-only signal beyond name matching. `undefined` means the source stands behind
 * this row's classification.
 *
 * No shipped adapter sets this yet - PR #67's classifiers always resolve to one of the
 * three RoomKinds by design (agoda-mapper.ts `classifyAgodaRoomKind`, booking-mapper.ts
 * `classifyBookingRoomKind` both return a definite kind, never "unsure"). This field
 * exists so the picker already honours "say what you don't know" (AGENTS.md, "When the
 * data is missing") the moment a provider can say so, instead of needing a second UI
 * change later.
 */
export interface StayOption {
	stay: Stay;
	notStated?: 'room-kind' | 'female-only';
}

/**
 * Every priced room-kind option at one property - at most one per RoomKind, mirroring
 * domain/stay.ts's own convention ("a property offering both a dorm bed and a private
 * room is two Stay records, not one Stay with two prices"). Must be non-empty; every
 * option's `stay.property` is the same object, read via `propertyOf` below rather than
 * duplicated onto this type.
 */
export interface PropertyStayOptions {
	options: StayOption[];
}

/** The property a group of options belongs to - every option's `stay.property` by
 * convention, so this just reads the first one rather than duplicating a `property`
 * field that could disagree with the options it sits next to. */
export function propertyOf(group: PropertyStayOptions): Property {
	return group.options[0].stay.property;
}

/**
 * Groups a flat `Stay[]` - exactly what `StayProvider.searchStays` resolves to
 * (providers/types.ts, issue #10's now-merged Agoda/Booking adapters) - into one
 * `PropertyStayOptions` per property, by reference equality of `stay.property`.
 *
 * That works because it is how every shipped adapter actually builds one: both
 * agoda-mapper.ts's `mapMasterRoomsToStays` and booking-mapper.ts's
 * `mapRoomBlocksToStays` construct every `Stay` for one property from the same
 * `Property` object literal, closing over it in a single `.map()` call. Two different
 * adapters describing what is really the same physical hostel still get two separate
 * groups here, since they build two distinct `Property` objects - matching hostels
 * across providers by name or coordinates is a harder problem this function does not
 * attempt, and guessing at it wrongly would silently merge two different price lists.
 */
export function groupByProperty(stays: readonly Stay[]): PropertyStayOptions[] {
	const groups: PropertyStayOptions[] = [];
	const indexByProperty = new Map<Property, number>();
	for (const stay of stays) {
		const existingIndex = indexByProperty.get(stay.property);
		if (existingIndex === undefined) {
			indexByProperty.set(stay.property, groups.length);
			groups.push({ options: [{ stay }] });
		} else {
			groups[existingIndex].options.push({ stay });
		}
	}
	return groups;
}
