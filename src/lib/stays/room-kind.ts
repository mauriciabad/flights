import type { RoomKind } from '$lib/domain';

/**
 * How each room kind is spelled for a traveller. One table, because two surfaces now name
 * the same room: the picker's tile and the stopover block (issue #228). Two tables would
 * be one bed called a "Dorm bed" in the picker and a "dorm" three centimetres away, which
 * is how `format.ts` came to exist in the first place.
 *
 * `female-dorm` and `male-dorm` are kinds of their own rather than flags on `dorm`, for the
 * reason `domain/stay.ts` gives: a gender-restricted bed is different inventory, not a
 * labelled version of the same one.
 *
 * "Dorm bed" carries no gender word on purpose. It is the mixed dorm, and after issue #288
 * it is only ever shown when the provider's own room listing holds a mixed dorm room, so
 * the missing word means "anyone", not "unknown".
 */
export const ROOM_KIND_LABELS: Record<RoomKind, string> = {
	dorm: 'Dorm bed',
	private: 'Private room',
	'female-dorm': 'Female-only dorm',
	'male-dorm': 'Male-only dorm'
};

/**
 * The two things a traveller is actually choosing between when they ask to see one or the
 * other: a bed in a room with other people in it, or a room of their own.
 *
 * Issue #423 asks for a filter over "dorm or provate room", and `RoomKind` has four values.
 * Offering four chips would put `Male-only dorm` in front of a party that cannot book one,
 * because who may sleep in a restricted dorm is already decided by the search's `females`
 * count through `gendered-room-fit.ts` and not by anything the traveller can click here. So
 * the restricted dorms fold into `dorm`, and the filter composes with the gender rule rather
 * than competing with it.
 */
export type BedKind = 'dorm' | 'private';

/** In the order the chips are drawn: the cheap one first, which is the order every other
 * price-led control on this screen uses. */
export const BED_KINDS: readonly BedKind[] = ['dorm', 'private'];

/**
 * Which of the two a room kind belongs to.
 *
 * A table rather than `roomKind === 'private' ? ... : 'dorm'`, so a fifth `RoomKind` is a
 * type error here instead of quietly defaulting to a dorm. `domain/stay.ts` treats a
 * restricted dorm as different inventory rather than a flag, and that is exactly the kind
 * of value this list grows.
 */
const BED_KIND_BY_ROOM_KIND: Record<RoomKind, BedKind> = {
	dorm: 'dorm',
	private: 'private',
	'female-dorm': 'dorm',
	'male-dorm': 'dorm'
};

export function bedKindOf(roomKind: RoomKind): BedKind {
	return BED_KIND_BY_ROOM_KIND[roomKind];
}

/** The same wording the room tiles use, so the chip that hides a room and the tile that
 * prices it call it one thing. `ROOM_KIND_LABELS` above is where both come from. */
export const BED_KIND_LABELS: Record<BedKind, string> = {
	dorm: ROOM_KIND_LABELS.dorm,
	private: ROOM_KIND_LABELS.private
};

/**
 * No narrowing at all, which is what an empty set means everywhere a chosen-set filter
 * appears in this app - `ResultFilters.chosenConnectionAirports` states the reasoning
 * (`results/filters.ts`). Shared rather than built per call so a `$derived` that falls back
 * to "no filter" does not hand its readers a new object on every recompute.
 */
export const NO_BED_KIND_FILTER: ReadonlySet<BedKind> = new Set();

/**
 * Whether a room of this kind survives the traveller's filter. Empty means every kind, so
 * an unset filter and a filter with both chips on are one answer rather than two code paths.
 */
export function allowsBedKind(allowed: ReadonlySet<BedKind> | undefined, roomKind: RoomKind): boolean {
	if (!allowed || allowed.size === 0) return true;
	return allowed.has(bedKindOf(roomKind));
}

/**
 * The same four kinds, named as ROOMS and in the plural, for a caption over a photograph
 * that is of rooms of this kind rather than of one room. Issue #449.
 *
 * Not a pluralisation of `ROOM_KIND_LABELS` above, and the difference is the point.
 * "Dorm bed" is what the traveller buys, one bed in a shared room. "Dorm rooms" is what a
 * set of photographs of the dorms at a property shows. A caption reading "Dorm beds at Rest
 * Up London" over a picture of a room would be describing the wrong object, and the plural
 * is what stops the reader taking any one of them for the room whose price is on screen.
 */
export const ROOM_KIND_PLURAL_LABELS: Record<RoomKind, string> = {
	dorm: 'Dorm rooms',
	private: 'Private rooms',
	'female-dorm': 'Female-only dorms',
	'male-dorm': 'Male-only dorms'
};
