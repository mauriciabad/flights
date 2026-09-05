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
