/**
 * Pure translation from Booking's raw response shapes (booking-types.ts) to this app's
 * domain shapes (src/lib/domain). No I/O, no cache, no fetch — same reasoning as
 * ryanair-mapper.ts and agoda-mapper.ts.
 */

import type { Money, Property, RoomKind, Stay } from '../../domain';
import type { BookingMoneyAmount, BookingRoomBlock, BookingRoomListResponse, BookingSearchResult } from './booking-types';

/** Reads only `value`/`currency` — never `amount_rounded`/`amount_unrounded`, which are
 * pre-formatted currency-symbol strings (e.g. "€ 100.15", non-breaking space included) for
 * Booking's own UI. Issue #10 warned specifically to watch for an API returning formatted
 * strings; this is that exact trap in this API. Assumes 2 minor-unit digits, which is
 * true of every currency this adapter has requested live (EUR) — unlike agoda-mapper.ts,
 * Booking's own wrapper exposes no per-currency decimal-count field to read instead, and
 * the 50-request/month budget did not stretch to confirming one from `getCurrency`
 * (untouched — see the PR body for the full list of endpoints this budget did reach).
 * Zero-decimal ISO 4217 currencies (JPY, KRW, VND, and a handful of others) would be
 * reported 100x too large until this gets a real per-currency table. */
export function toMoney(amount: BookingMoneyAmount): Money | undefined {
	if (amount.value === undefined || !amount.currency) return undefined;
	return { minorUnits: Math.round(amount.value * 100), currency: amount.currency };
}

/**
 * Classifies one Booking room-type name (plus its `is_dormitory` flag) into this app's
 * three-way `RoomKind` (domain/stay.ts). Unlike agoda-mapper.ts's `classifyAgodaRoomKind`,
 * `is_dormitory` is trusted here — it is Booking's own structured field, confirmed live to
 * exist and read `0` correctly for an ordinary hotel's twin/double rooms, not a
 * same-named-but-broken flag the way Agoda's turned out to be. What was NOT verified live
 * (the 50-request/month budget ran out first) is that it actually reads `1` for a real
 * dorm room — see booking-types.ts's `BookingRoomBlock.is_dormitory` comment and the PR
 * body's "hostel data" section. Name matching still runs as a second, OR'd signal rather
 * than being dropped, both because that gap exists and because Booking has no dedicated
 * field for the female-only case at all — a name check is the only way to catch that
 * regardless of how reliable `is_dormitory` proves to be.
 *
 * "Private" is checked first for the same reason agoda-mapper.ts checks it first: a
 * private multi-bed room can plausibly be named with the word "dorm" in it (not confirmed
 * live for Booking specifically, but Agoda's "Private 6 Bed Dorm Room" shows the pattern
 * exists on at least one of these two providers, so this adapter treats it as a real risk
 * rather than an Agoda-only quirk).
 */
export function classifyBookingRoomKind(roomName: string, isDormitory: 0 | 1 | undefined): RoomKind {
	if (/\bprivate\b/i.test(roomName)) return 'private';
	const isDormLike = isDormitory === 1 || /dorm|dormitory|\bbed in\b|shared\s+room/i.test(roomName);
	if (isDormLike && /\bfemale\b|\bwomen'?s?\b|\bladies\b/i.test(roomName)) return 'female-dorm';
	if (isDormLike) return 'dorm';
	return 'private';
}

export interface BookingCandidate {
	hotelId: number;
	property: Property;
	headlinePrice: Money;
}

/** Maps one search result to a rankable candidate, or `undefined` when it is missing a
 * name, coordinates, or a live price — mirrors agoda-mapper.ts
 * `mapSearchPropertyToCandidate`'s same three-field requirement. Booking's own search
 * already filters by the requested coordinate and radius server-side (unlike Agoda's), so
 * there is no separate client-side radius filter here. */
export function mapSearchResultToCandidate(result: BookingSearchResult): BookingCandidate | undefined {
	const { hotel_name: name, latitude, longitude } = result;
	const headlinePrice = toMoney(result.composite_price_breakdown?.gross_amount_per_night ?? {});
	if (!name || latitude === undefined || longitude === undefined || !headlinePrice) return undefined;

	return {
		hotelId: result.hotel_id,
		property: {
			name,
			coordinates: { latitude, longitude },
			images: result.main_photo_url ? [result.main_photo_url] : [],
			rating: result.review_score ?? undefined
		},
		headlinePrice
	};
}

/** One Stay per `RoomKind` actually present at this property, each at that kind's
 * cheapest block — same "dorm vs private, not every named variant" grouping
 * agoda-mapper.ts's `mapMasterRoomsToStays` does, and for the same reason: domain/stay.ts
 * wants one Stay per priced room-kind option, not one per rate plan. */
export function mapRoomBlocksToStays(property: Property, blocks: readonly BookingRoomBlock[]): Stay[] {
	const cheapestByKind = new Map<RoomKind, Money>();
	for (const block of blocks) {
		if (!block.room_name) continue;
		const price = toMoney(block.product_price_breakdown?.gross_amount_per_night ?? {});
		if (!price) continue;
		const kind = classifyBookingRoomKind(block.room_name, block.is_dormitory);
		const existing = cheapestByKind.get(kind);
		if (!existing || price.minorUnits < existing.minorUnits) cheapestByKind.set(kind, price);
	}
	return Array.from(cheapestByKind.entries()).map(([roomKind, pricePerNight]) => ({
		property,
		roomKind,
		pricePerNight
	}));
}

export function mapRoomListToStays(property: Property, response: BookingRoomListResponse): Stay[] {
	return mapRoomBlocksToStays(property, response.data?.block ?? []);
}
