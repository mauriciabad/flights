/**
 * One list of photographs out of a property and the stays at it, with every entry saying
 * what it is a picture of. Issue #442.
 *
 * ## Why the two sets are merged here and nowhere else
 *
 * `Property.images` is the building and `Stay.roomImages` is the room, and the rule the
 * issue turns on is that neither may ever be presented as the other. That rule is a
 * property of one function if the merge happens once, and a promise three components have
 * to keep if it does not. `PhotoCarousel` takes the merged list rather than the two arrays,
 * so there is no arrangement of props that draws a room photograph under a building's
 * caption.
 *
 * The building comes first because it is the picture a reader expects a hostel card to
 * open on, and because it is the one every provider actually sends.
 *
 * ## A photograph can belong to more than one room
 *
 * Measured at Hostelworld property 312244: the female dorm and the mixed dorm publish the
 * same three addresses, and the private publishes four of its own. So a caption naming the
 * first room kind that happened to claim a photograph would be wrong half the time, and
 * every kind that claims one is named instead. Two rooms sharing a picture is how the
 * provider files them, not a mix-up.
 *
 * A photograph the property also publishes stays the property's. It really is both, and of
 * the two readings the building is the one that cannot mislead: nobody is disappointed to
 * find the exterior shot is also in the room's gallery, and somebody would be to book a bed
 * on the strength of a lobby.
 */

import type { Property, RoomKind, Stay } from '$lib/domain';
import { ROOM_KIND_LABELS } from './room-kind';

/** What a photograph is a picture of. The carousel and the lightbox both read it, and it
 * is the only thing standing between a lobby and a claim about a dorm. */
export type PhotoSubject = 'property' | 'room';

export interface StayPhoto {
	/** Card-sized already, through the provider's own `*-photo.ts` rewriter. */
	src: string;
	subject: PhotoSubject;
	/** What this is a picture of, in words a reader sees: "Rest Up London", or "Female-only
	 * dorm at Rest Up London". Never a bare room kind, because a room kind with no property
	 * on it reads as a category rather than as this room. */
	caption: string;
}

/** "Female-only dorm and male-only dorm", for the photograph both of them publish. Lower
 * case after the first, since this lands mid-caption. */
function describeKinds(kinds: readonly RoomKind[]): string {
	const labels = kinds.map((kind, index) =>
		index === 0 ? ROOM_KIND_LABELS[kind] : ROOM_KIND_LABELS[kind].toLowerCase()
	);
	if (labels.length <= 1) return labels[0] ?? '';
	return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Every photograph on offer for one property, the building's first and each room's after
 * it, each one labelled with what it shows.
 *
 * `stays` is however many of that property's room kinds the surface is showing. One for the
 * picked bed, all of them for the picker's open card and the map's sidebar. Passing none is
 * a property with no room in view, which is the building's photographs and nothing else.
 */
export function stayPhotos(property: Property, stays: readonly Stay[] = []): StayPhoto[] {
	const building = new Set(property.images);
	const rooms = new Map<string, RoomKind[]>();
	for (const stay of stays) {
		for (const src of stay.roomImages ?? []) {
			if (building.has(src)) continue;
			const kinds = rooms.get(src);
			if (!kinds) rooms.set(src, [stay.roomKind]);
			else if (!kinds.includes(stay.roomKind)) kinds.push(stay.roomKind);
		}
	}
	return [
		...[...building].map((src): StayPhoto => ({
			src,
			subject: 'property',
			caption: property.name
		})),
		...[...rooms].map(([src, kinds]): StayPhoto => ({
			src,
			subject: 'room',
			caption: `${describeKinds(kinds)} at ${property.name}`
		}))
	];
}

/**
 * What a screen reader is told about one photograph.
 *
 * The position is in here rather than in the caption because a caption is what a sighted
 * reader sees under the picture and "photo 2 of 5" is already on screen as a counter beside
 * it. A single photograph gets no position at all: "photo 1 of 1" is noise.
 */
export function photoAlt(photo: StayPhoto, position: number, total: number): string {
	return total > 1 ? `${photo.caption}, photo ${position} of ${total}` : photo.caption;
}
