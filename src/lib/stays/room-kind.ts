import type { RoomKind } from '$lib/domain';

/**
 * How each room kind is spelled for a traveller. One table, because two surfaces now name
 * the same room: the picker's tile and the stopover block (issue #228). Two tables would
 * be one bed called a "Dorm bed" in the picker and a "dorm" three centimetres away, which
 * is how `format.ts` came to exist in the first place.
 *
 * `female-dorm` is a kind of its own rather than a flag on `dorm` for the reason
 * `domain/stay.ts` gives: a female dorm bed is different inventory, not a labelled version
 * of the same one.
 */
export const ROOM_KIND_LABELS: Record<RoomKind, string> = {
	dorm: 'Dorm bed',
	private: 'Private room',
	'female-dorm': 'Female-only dorm'
};
