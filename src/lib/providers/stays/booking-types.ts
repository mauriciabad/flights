/**
 * Raw shapes returned by Booking.com's RapidAPI wrapper (`booking-com15.p.rapidapi.com`,
 * provider `DataCrawler`). Kept separate from the mapped domain shapes in
 * booking-mapper.ts for the same reason ryanair-types.ts gives: a future schema change is
 * caught at the mapping boundary, not as an `any` leaking deeper into the adapter.
 *
 * Captured 2026-09-04 from real requests against `searchHotelsByCoordinates` (near VIE
 * airport and near Vienna's city centre) and `getRoomList` — see the PR body for the exact
 * requests and a summary of what came back. This adapter's RapidAPI budget is 50
 * requests/month (docs/PROVIDERS.md), the tightest of any provider in this app, so only
 * five real calls were spent confirming this shape; only the fields this adapter actually
 * reads are modelled, and `getRoomList`'s behaviour on an ACTUAL dorm room (as opposed to
 * the ordinary hotel this adapter's one live sample happened to be) was not verified live
 * — see this file's `BookingRoomBlock.is_dormitory` comment and the PR body's "hostel
 * data" section for exactly what is and isn't confirmed.
 */

/** `GET api/v1/hotels/searchHotelsByCoordinates?latitude=...&longitude=...&radius=...`.
 * Confirmed live: `radius=5` fails validation (`{"radius":"Invalid value"}`), `radius=10`
 * succeeds — booking-client.ts clamps to that floor since the true minimum wasn't
 * determined more precisely than "somewhere between 5 and 10". */
export interface BookingSearchResponse {
	data?: {
		result?: BookingSearchResult[];
	};
}

export interface BookingSearchResult {
	hotel_id: number;
	hotel_name?: string;
	latitude?: number;
	longitude?: number;
	main_photo_url?: string;
	/** Out of 10 (a live "Pannonia Tower" result scored 8.8) — passed through raw, same
	 * as Agoda's out-of-5 scale, per domain/stay.ts's Property.rating comment. */
	review_score?: number;
	composite_price_breakdown?: {
		gross_amount_per_night?: BookingMoneyAmount;
	};
}

/**
 * Booking's price fields always come as this pair: `value` (a plain float in major units —
 * SAFE to convert) alongside `amount_rounded`/`amount_unrounded` (currency-symbol strings
 * like "€ 100.15", with a non-breaking space before the digits — NEVER parse these; they
 * exist for Booking's own UI, and issue #10 warned specifically to "watch for the API
 * returning formatted strings"). booking-mapper.ts's `toMoney` reads only `value` and
 * `currency`.
 */
export interface BookingMoneyAmount {
	value?: number;
	currency?: string;
	amount_rounded?: string;
	amount_unrounded?: string;
}

/** `GET api/v1/hotels/getRoomList?hotel_id=...`. One `block` per room type/rate-plan
 * combination — booking-mapper.ts groups these by the `RoomKind` it derives from each
 * block, same "one Stay per kind, not per named variant" grouping agoda-mapper.ts does. */
export interface BookingRoomListResponse {
	data?: {
		block?: BookingRoomBlock[];
	};
}

export interface BookingRoomBlock {
	room_name?: string;
	/**
	 * A real, structured field in Booking's own room taxonomy — unlike Agoda's
	 * same-named-but-broken flag (agoda-types.ts's `AgodaMasterRoom.isDormitory`), this
	 * one is genuine Booking schema used across their whole site. It was confirmed
	 * present and typed correctly (`0`) live against Ibis Vienna Airport, an ordinary
	 * hotel with no dorm rooms — the 50-request/month budget did not stretch to also
	 * confirming it reads `1` for an actual dorm room at a real Vienna hostel. Treated as
	 * a real signal here, combined with name matching for the female-only case Booking has
	 * no dedicated field for at all — see booking-mapper.ts `classifyBookingRoomKind` and
	 * the PR body's "hostel data" section for the honest state of this.
	 */
	is_dormitory?: 0 | 1;
	max_occupancy?: number;
	product_price_breakdown?: {
		gross_amount_per_night?: BookingMoneyAmount;
	};
}

/** Failure modes of one HTTP call to Booking's RapidAPI gateway. Distinct from and
 * narrower than `ProviderError` (src/lib/providers/types.ts) — same split ryanair-types.ts
 * and agoda-types.ts make, mapped up to that shared union at the adapter boundary. */
export type BookingFetchError =
	| { code: 'cancelled'; message: string }
	| { code: 'network-error'; message: string; cause?: unknown }
	| { code: 'malformed-response'; message: string; cause?: unknown }
	| { code: 'not-subscribed'; message: string; status: 403 }
	| { code: 'rate-limited'; message: string; status: 429; retryAfterSeconds?: number }
	| { code: 'http-error'; message: string; status: number };

export type BookingFetchResult<T> = { ok: true; data: T } | { ok: false; error: BookingFetchError };
