/**
 * Asking one provider about one property's rooms, on demand. Issue #449.
 *
 * `fetch-reach.ts` is the shape this follows: the module that owns provider access does the
 * asking, the components take the answer as a prop and stay pure functions of their props.
 *
 * ## One provider answers this, and that is measured rather than a starting point
 *
 * docs/PROVIDERS.md's room table, read off captures already on disk on 2026-09-07:
 * Hostelworld's per-property availability response carries `rooms.dorms[].images` and
 * `rooms.privates[].images`; Booking's `getRoomList` block carries none; Agoda's
 * `get-prices` master room carries none and its search carries the building only. Booking
 * and Agoda are metered and the owner told us not to spend his quota, so whether some other
 * endpoint of theirs would carry room photographs is a thing this branch did not go and find
 * out. `roomPhotosAvailableFrom` says which of the two that is for any given provider, so a
 * surface can stay quiet instead of holding a placeholder for an answer that is not coming.
 *
 * A `switch` rather than a table of one entry. It is exhaustive over `ProviderId`, so a new
 * adapter is a compile error here until somebody decides what it publishes.
 */

import type { Itinerary, ProviderId, RoomPhotoLookup, Stay } from '$lib/domain';
import type { ProviderContext } from '$lib/providers/types';
import {
	hostelworldRoomPhotos,
	type HostelworldRoomPhotosOptions
} from '$lib/providers/stays/hostelworld-rooms';

/** The stay this is being asked about, reduced to what the request needs. Every field comes
 * off the itinerary that priced the bed, so the rooms that come back are the rooms that were
 * on offer for the nights being booked. */
export interface RoomPhotoQuery {
	/** Check-in, `YYYY-MM-DD`, local at the property. AGENTS.md: a calendar date at a place,
	 * never an instant. */
	checkIn: string;
	nights: number;
	guests: number;
	currency: string;
}

/** One answer, and whether it is the held one or the one that just arrived. */
export interface RoomPhotoAnswer {
	photos: RoomPhotoLookup;
	state: 'stale' | 'fresh' | 'expired-fallback';
	/** What this yield cost, so a caller can report a real number. */
	requestsUsed: number;
}

/**
 * Whether asking this provider could produce anything. `false` is a measured fact about the
 * endpoints this app calls, not a guess about the provider.
 */
export function roomPhotosAvailableFrom(provider: ProviderId): boolean {
	return provider === 'hostelworld';
}

/**
 * Every photograph one provider publishes for the rooms at one property, cached answer
 * first and the fresh one after it, in the "stale first, then fresh" shape AGENTS.md asks
 * for by name. Yields nothing at all for a stay with no `source` and for a provider that
 * publishes none, so a caller can drive this without checking twice.
 *
 * Rejects rather than yielding on a failure with nothing held, carrying the provider's own
 * message. The caller decides whether that is worth putting on screen; what it must not do
 * is invent a sentence of its own (AGENTS.md, "show the error you got").
 */
export async function* stayRoomPhotos(
	stay: Stay,
	query: RoomPhotoQuery,
	ctx: ProviderContext,
	options: HostelworldRoomPhotosOptions = {}
): AsyncGenerator<RoomPhotoAnswer, void, unknown> {
	const source = stay.source;
	if (!source) return;

	switch (source.provider) {
		case 'hostelworld':
			yield* hostelworldRoomPhotos({ propertyId: source.propertyId, ...query }, ctx, options);
			return;
		case 'agoda':
		case 'booking':
		case 'skyscanner':
		case 'flights-sky':
		case 'kiwi':
		case 'kiwi-public':
		case 'ryanair':
		case 'transitous':
		case 'transitous-geocode':
		case 'travelpayouts-cheap-routes':
		case 'osrm':
			return;
	}
}

/**
 * The stay one itinerary describes, as something a provider can be asked about, or
 * `undefined` when there is no bed in it to ask about.
 *
 * Here rather than at the call site because it is the one place the trip's own clock becomes
 * a request parameter, and getting it wrong is the class of mistake AGENTS.md spends a whole
 * section on. `freeTime.start` is a local wall clock at the connection airport, so its
 * calendar date is the date the traveller checks in AT THE HOTEL. Normalising to UTC and
 * formatting it back is how an overnight stopover loses a night.
 *
 * The nights are `nightsInConnection`, which `algorithm/nights.ts` counts the way a front
 * desk does, by calendar dates crossed rather than by dividing free time by 24. The currency
 * is the one the bed was quoted in rather than the search's, because a provider that
 * substituted a currency has to be asked in the currency it answered.
 */
export function roomPhotoQueryFor(itinerary: Itinerary): RoomPhotoQuery | undefined {
	const stay = itinerary.stay;
	if (!stay || itinerary.nightsInConnection <= 0) return undefined;
	return {
		checkIn: itinerary.freeTime.start.local.slice(0, 10),
		nights: itinerary.nightsInConnection,
		guests: itinerary.travellers,
		currency: stay.pricePerNight.currency
	};
}
