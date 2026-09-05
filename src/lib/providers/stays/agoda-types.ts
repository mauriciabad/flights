/**
 * Raw shapes returned by Agoda's RapidAPI wrapper (`agoda-com.p.rapidapi.com`, provider
 * `ntd119`) and by the OSM Nominatim reverse-geocoder this adapter leans on (see
 * agoda-client.ts's header comment for why). Kept separate from the mapped domain shapes
 * in agoda-mapper.ts so a future schema change is caught at the mapping boundary instead
 * of an `any` leaking deeper into the adapter — same reasoning as ryanair-types.ts.
 *
 * Captured 2026-09-04 from real requests against `hotels-homes/overnight-stays/search` and
 * `hotels-homes/get-prices` for Vienna (see the PR body for the exact requests and a
 * summary of what came back). Only the fields this adapter actually reads are modelled;
 * both endpoints return far more than this, most of it booking-funnel plumbing (deep
 * links, A/B experiment flags, loyalty program state) this app has no use for.
 */

/** `GET hotels-homes/overnight-stays/search?location=...&checkin_date=...&checkout_date=...`.
 * One entry per property Agoda considers a match for the resolved location text — see
 * agoda-client.ts for why this is text, not the coordinate this adapter was actually
 * asked to search near. */
export interface AgodaSearchResponse {
	data?: {
		properties?: AgodaSearchProperty[];
	};
}

export interface AgodaSearchProperty {
	propertyId: number;
	/** Present once a property has no live inventory for the requested dates — its
	 * `pricing.offers` is empty in that case, so this adapter treats the two as
	 * equivalent "skip this one" signals rather than trusting either alone. */
	soldOut?: unknown;
	content?: {
		informationSummary?: {
			displayName?: string;
			/** Out of 5 in every property this adapter has seen live (docs/PROVIDERS.md
			 * convention: pass the raw provider scale through, with `outOf: 5` beside it so
			 * a screen knows which scale it has — domain/stay.ts's `PropertyRating`). */
			rating?: number | null;
			geoInfo?: { latitude?: number; longitude?: number };
		};
		images?: {
			hotelImages?: { urls?: { key?: string; value?: string }[] }[];
		};
	};
	/** The property-level "from" price used to rank candidates before this adapter spends
	 * a request drilling into any one of them with `get-prices` — NOT a per-room-kind
	 * price, since Agoda's search response never breaks a property down by room type (see
	 * agoda-mapper.ts `extractHeadlinePrice` for exactly where this is buried and why). */
	pricing?: {
		offers?: {
			roomOffers?: {
				room?: {
					mseRoomSummaries?: {
						pricingSummaries?: {
							currency?: string;
							price?: { perRoomPerNight?: { inclusive?: { display?: number } } };
						}[];
					}[];
				};
			}[];
		}[];
	};
}

/** `GET hotels-homes/get-prices?property_id=...&checkin_date=...&checkout_date=...`. One
 * `masterRooms` entry per room TYPE the property lists (not per bed, not per booking
 * option) — issue #10's "dorm and private priced separately" is this array grouped by
 * the room-kind agoda-mapper.ts derives from each entry's `name`. */
export interface AgodaGetPricesResponse {
	data?: {
		currencyInfo?: { code?: string };
		roomGridData?: {
			masterRooms?: AgodaMasterRoom[];
		};
	};
}

export interface AgodaMasterRoom {
	name?: string;
	/**
	 * Documented as "is this a shared dormitory room," which is exactly the signal issue
	 * #10 needs — except live testing against Wombat's City Hostel Vienna (a real hostel
	 * with obvious dorm rooms, propertyId 417108, captured 2026-09-04) returned `false`
	 * here for all 13 of its room types, including ones literally named "1 Person in
	 * 8-Bed Dormitory - Mixed." This field cannot be trusted; agoda-mapper.ts classifies
	 * from `name` instead and keeps this only as a secondary, non-decisive signal. See the
	 * PR body's "hostel data" section for the full room list this finding is based on.
	 */
	isDormitory?: boolean;
	maxOccupancy?: number;
	/** One entry per occupancy/rate-plan variant of this room type (e.g. the same "Double
	 * Room" priced for 1 vs 2 adults) — agoda-mapper.ts picks the cheapest as this room
	 * type's representative price, per StayProvider's "one Stay per priced room-kind
	 * option," not one per occupancy variant. */
	rooms?: AgodaRoomOffer[];
}

export interface AgodaRoomOffer {
	currency?: string;
	/** Tax-inclusive, per night, for one unit of this room (a bed for a dorm entry, the
	 * whole room for a private one) — NOT `totalPrice` (a live check found that field's
	 * ratio to this one is not a clean multiple of the requested night count, so it likely
	 * reflects a different default stay length internally) and NOT `perNightPrice` (this
	 * endpoint's own `exclusivePrice`, tax-exclusive — this adapter wants the number a
	 * traveller will actually be charged). Confirmed identical to `inclusivePrice.display`
	 * in every room this adapter has seen live, since none carried an extra bed. */
	inclusivePricePerNightWithoutExtraBed?: { display?: number };
	inclusivePrice?: { display?: number };
}

/** Failure modes of one HTTP call this adapter makes — to Agoda's RapidAPI gateway or to
 * Nominatim, both folded into one union since the caller (agoda.ts) handles both the same
 * way: map to `ProviderError` and move on. Distinct from and narrower than `ProviderError`
 * (src/lib/providers/types.ts) for the same reason ryanair-types.ts gives: `rate-limited`
 * here is a raw HTTP fact (429 from either host) and gets renamed to `quota-exceeded` only
 * at the adapter boundary, where it also gains the "this only applies to Agoda's own
 * quota" caveat a Nominatim 429 would need. */
export type AgodaFetchError =
	| { code: 'cancelled'; message: string }
	| { code: 'network-error'; message: string; cause?: unknown }
	| { code: 'malformed-response'; message: string; cause?: unknown }
	| { code: 'not-subscribed'; message: string; status: 403 }
	| { code: 'rate-limited'; message: string; status: 429; retryAfterSeconds?: number }
	| { code: 'http-error'; message: string; status: number };

export type AgodaFetchResult<T> = { ok: true; data: T } | { ok: false; error: AgodaFetchError };

/** `GET https://nominatim.openstreetmap.org/reverse?...` — see agoda-client.ts for why
 * this adapter calls a second, unrelated, keyless host at all. Only the address levels
 * this adapter tries, in the order it tries them, are modelled. */
export interface NominatimReverseResponse {
	address?: {
		city?: string;
		town?: string;
		village?: string;
		hamlet?: string;
		country?: string;
	};
}
