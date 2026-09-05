/**
 * Types the stay picker (issue #27) needs beyond the shared Stay/RoomKind domain
 * (domain/stay.ts, issue #1) and the StayProvider contract (providers/types.ts, issue
 * #2). Picker-local rather than added to either shared file: issue #10's Agoda/Booking
 * adapters (PR #67) return a plain `Stay[]` for a search, and grouping those into "one
 * property, its room kinds" is a display concern this component owns, not something
 * every StayProvider caller needs.
 *
 * AGENTS.md: "If your issue depends on something that does not exist yet, do not
 * invent a competing version of it... define the narrowest possible interface." This
 * was written before PR #67 merged, on that basis - additive on top of `Stay`, not a
 * redesign of it, and it still holds true now that the adapters are real: neither
 * `Stay`/`RoomKind` nor `StayProvider` needed to change for this picker to work.
 */

import type { Property, Stay } from '$lib/domain';

/**
 * One priced room-kind option at a property.
 *
 * This carried a `notStated` marker until issue #300, meant for a row whose dorm/private
 * split or female-only status the source had not confirmed. Nothing ever set it, in any
 * of the three adapters, because every mapper resolves a `Stay` to a definite `RoomKind`
 * before it reaches here.
 *
 * Deleted rather than given a producer. The one honest case is a Hostelworld property
 * quoting a dorm price with no room breakdown, and `tools/probe-female-dorms.mjs` counted
 * that at 0 of 91 properties across Rome, London, Berlin and Paphos on 2026-09-05, since
 * `show-rooms=1` is mandatory. Bring the marker back when a provider can actually say
 * "unsure". It will need a carrier on `Stay` first, because this type only ever sees what
 * the mappers already decided.
 */
export interface StayOption {
	stay: Stay;
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
 * `PropertyStayOptions` per property, keyed on the property's own values.
 *
 * This used to key on reference equality of `stay.property`, which was true of every
 * adapter's output and false of ours. Both mappers do build all of one property's stays
 * from a single `Property` literal, so identity held on a fresh fetch. It does not
 * survive the cache: a stay read back out of IndexedDB has been through JSON, so every
 * `Stay` carries its own structurally-equal but distinct `Property`. The same hotel then
 * grouped once per room price, and `StayPicker.svelte` keys its `{#each}` on name plus
 * coordinates, so the repeats collided and Svelte threw `each_key_duplicate` - taking
 * the whole detail panel down with it (#188).
 *
 * Keying on the same values the template keys on makes that class of crash
 * unrepresentable rather than merely fixed.
 *
 * Two adapters describing the same physical hostel now do merge, where before they got
 * two groups. That needs an exact match on name and on both coordinates, which is a
 * strong enough signal to prefer over showing the owner the same hostel twice. Merging
 * makes a room kind reachable from two providers at two prices, so the cheaper one wins
 * and the type's "at most one option per RoomKind" promise still holds. Prices in
 * different currencies are not compared, since minor units across currencies are not
 * ordered - the first seen is kept and the other dropped.
 */
/** The identity StayPicker.svelte's `{#each}` keys on. Kept beside the grouping so the
 * two cannot drift apart again. */
export function propertyKey(property: Property): string {
	return `${property.name}@${property.coordinates.latitude},${property.coordinates.longitude}`;
}

/**
 * Whether two records describe one property, by the same identity the grouping above uses.
 * Reference equality is the wrong question for the reason `groupByProperty` documents: a
 * stay read back out of IndexedDB has been through JSON and carries its own structurally
 * equal `Property`.
 *
 * Issue #243 asks it of an itinerary rather than of a list: the two in-city transfers were
 * routed to one address, so they hold for the property the traveller has picked only if it
 * is that address. `undefined` on either side is "no property", which never matches one.
 */
export function isSameProperty(a?: Property, b?: Property): boolean {
	if (!a || !b) return false;
	return propertyKey(a) === propertyKey(b);
}

/**
 * Whether two stays are the same room at the same address.
 *
 * Reference equality does not answer this. A stay read back out of IndexedDB has been
 * through JSON, so the candidate list and the itinerary can hold structurally equal but
 * distinct copies of one hostel, which is the same trap `propertyKey` exists for (#188).
 */
export function isSameBed(a?: Stay, b?: Stay): boolean {
	if (!a || !b) return false;
	return a.roomKind === b.roomKind && isSameProperty(a.property, b.property);
}

export function groupByProperty(stays: readonly Stay[]): PropertyStayOptions[] {
	const groups: PropertyStayOptions[] = [];
	const indexByKey = new Map<string, number>();
	for (const stay of stays) {
		const key = propertyKey(stay.property);
		const existingIndex = indexByKey.get(key);
		if (existingIndex === undefined) {
			indexByKey.set(key, groups.length);
			groups.push({ options: [{ stay }] });
			continue;
		}
		const options = groups[existingIndex].options;
		const sameKind = options.findIndex((o) => o.stay.roomKind === stay.roomKind);
		if (sameKind === -1) {
			options.push({ stay });
			continue;
		}
		const held = options[sameKind].stay.pricePerNight;
		const offered = stay.pricePerNight;
		if (held.currency === offered.currency && offered.minorUnits < held.minorUnits) {
			options[sameKind] = { stay };
		}
	}
	return groups;
}

