/**
 * One list of photographs out of a property and the stays at it, with every entry saying
 * what it is a picture of. Issue #442, extended by #449.
 *
 * ## Why the sets are merged here and nowhere else
 *
 * `Property.images` is the building, `Stay.roomImages` is the room, and a `RoomPhotoLookup`
 * is whatever a provider was asked for on demand about one property's rooms. The rule the
 * issues turn on is that none of them may ever be presented as another. That rule is a
 * property of one function if the merge happens once, and a promise three components have
 * to keep if it does not. `PhotoCarousel` takes the merged list rather than the arrays, so
 * there is no arrangement of props that draws a room photograph under a building's caption.
 *
 * The building comes first because it is the picture a reader expects a hostel card to open
 * on, and because it is the one every provider actually sends.
 *
 * ## Three claims, not two, and the middle one is the whole of #449
 *
 * A `female-dorm` or a `male-dorm` at Hostelworld is priced from one named room, so a
 * photograph of that room belongs under that price. `subject: 'room'`.
 *
 * A `dorm` or a `private` is priced from `lowestAverage*PricePerNight`, a property-level
 * average over rates no single room quotes. There is no room whose photograph could go under
 * that price, and `hostelworld-mapper.ts` has always refused to invent one. That refusal is
 * right and it left the two commonest kinds with nothing. Measured 2026-09-08 across thirty
 * London properties with `tools/probe-hostelworld-rooms.mjs`, 128 of 228 rooms are mixed
 * dorms and 52 are privates, so refusing outright ships a feature most travellers never
 * reach.
 *
 * So there is a third, weaker, true claim. These are the dorms at this property. Not the
 * dorm the rate came from, because nobody knows which one that is. `subject: 'room-kind'`,
 * captioned and badged in the plural, and that plural is doing real work: "Dorm rooms at
 * Rest Up London" is a sentence a reader cannot mistake for "this is the bed you are
 * buying". A restricted dorm never contributes to `dorm` and a mixed one never to
 * `female-dorm` (`mapAvailabilityToRoomPhotos` keeps them apart), because those are
 * different inventory and #288 is what pooling them looks like.
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
 * on the strength of a lobby. For the same reason, a photograph claimed as one room's own
 * outranks the same photograph claimed only as a room of that kind.
 */

import type { Property, RoomKind, RoomPhotoLookup, Stay } from '$lib/domain';
import { ROOM_KIND_LABELS, ROOM_KIND_PLURAL_LABELS } from './room-kind';

/**
 * What a photograph is a picture of. The carousel and the lightbox both read it, and it is
 * the only thing standing between a lobby and a claim about a dorm.
 *
 * `'room'` is the room whose rate is quoted. `'room-kind'` is a room of that kind at that
 * property, which is a weaker claim and is labelled as one. Nothing may promote the second
 * to the first.
 */
export type PhotoSubject = 'property' | 'room' | 'room-kind';

export interface StayPhoto {
	/** Card-sized already, through the provider's own `*-photo.ts` rewriter. */
	src: string;
	subject: PhotoSubject;
	/** What this is a picture of, in words a reader sees: "Rest Up London", "Female-only
	 * dorm at Rest Up London", "Dorm rooms at Rest Up London". Never a bare room kind,
	 * because a room kind with no property on it reads as a category rather than as this
	 * room. */
	caption: string;
	/** The two or three words drawn over the photograph itself, and `undefined` for the
	 * building, which needs none. Absent exactly when `subject` is `'property'`. It is
	 * built here rather than in the carousel so the badge and the caption can never make
	 * two different claims about one picture. */
	badge?: string;
}

/** "Female-only dorm and male-only dorm", for the photograph both of them publish. Lower
 * case after the first, since this lands mid-caption. */
function describeKinds(kinds: readonly RoomKind[], labels: Record<RoomKind, string>): string {
	const named = kinds.map((kind, index) =>
		index === 0 ? labels[kind] : labels[kind].toLowerCase()
	);
	if (named.length <= 1) return named[0] ?? '';
	return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/** Which room kinds claim one photograph, and whether any of them claims it as its own
 * room rather than as a room of its kind. */
interface PhotoClaim {
	kinds: RoomKind[];
	/** True once some stay's own priced room publishes this. Once true it stays true: the
	 * stronger claim is the honest one to print when both are available. */
	exact: boolean;
}

/**
 * Every photograph on offer for one property, the building's first and each room's after
 * it, each one labelled with what it shows.
 *
 * `stays` is however many of that property's room kinds the surface is showing. One for the
 * picked bed, all of them for the picker's open card and the map's sidebar. Passing none is
 * a property with no room in view, which is the building's photographs and nothing else.
 *
 * `rooms` is what a provider answered on demand about this property (`fetch-room-photos.ts`),
 * and `undefined` means nobody asked or the answer has not landed. Absent is not empty: a
 * property whose rooms carry no photographs at all is 4 in 30 on a live London page, and it
 * renders exactly as it did before this argument existed.
 */
export function stayPhotos(
	property: Property,
	stays: readonly Stay[] = [],
	rooms?: RoomPhotoLookup
): StayPhoto[] {
	const building = new Set(property.images);
	const claims = new Map<string, PhotoClaim>();

	const claim = (src: string, kind: RoomKind, exact: boolean): void => {
		if (building.has(src)) return;
		const held = claims.get(src);
		if (!held) {
			claims.set(src, { kinds: [kind], exact });
			return;
		}
		if (!held.kinds.includes(kind)) held.kinds.push(kind);
		held.exact ||= exact;
	};

	for (const stay of stays) {
		for (const src of stay.roomImages ?? []) claim(src, stay.roomKind, true);
		if (!rooms) continue;

		// The room the rate came from, when the provider named one and it is the same provider
		// that answered. `Stay.source.roomId` is absent for a `dorm` and a `private`, which is
		// why the weaker claim below exists at all; the provider test is because two adapters
		// can describe one building and their room ids come from different namespaces.
		const roomId = stay.source?.provider === rooms.provider ? stay.source.roomId : undefined;
		const own = roomId === undefined ? undefined : rooms.byRoomId[roomId];
		if (own && own.length > 0) {
			for (const src of own) claim(src, stay.roomKind, true);
			continue;
		}

		// No provider test here, and that is deliberate. "These are the dorms at this property"
		// is a claim about the building, and `groupByProperty` only merged these two records
		// because they are the same building.
		for (const src of rooms.byKind[stay.roomKind] ?? []) claim(src, stay.roomKind, false);
	}

	return [
		...[...building].map(
			(src): StayPhoto => ({ src, subject: 'property', caption: property.name })
		),
		...[...claims].map(([src, held]): StayPhoto => {
			if (held.exact) {
				return {
					src,
					subject: 'room',
					caption: `${describeKinds(held.kinds, ROOM_KIND_LABELS)} at ${property.name}`,
					badge: 'Room'
				};
			}
			return {
				src,
				subject: 'room-kind',
				caption: `${describeKinds(held.kinds, ROOM_KIND_PLURAL_LABELS)} at ${property.name}`,
				// One kind gets its own name; two or more get the bare plural. The badge sits in
				// the corner of the photograph opposite the counter, and "Female-only dorms and
				// male-only dorms" would run into it. The caption still names every kind, and
				// "Rooms" is the same claim in fewer words, meaning rooms of this sort here rather
				// than the one whose price is on screen.
				badge:
					held.kinds.length === 1 ? ROOM_KIND_PLURAL_LABELS[held.kinds[0]] : 'Rooms'
			};
		})
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
