/**
 * Raw shapes returned by Hostelworld's own web backend (`prod.apigee.hostelworld.com`),
 * the two endpoints its website runs on. Kept separate from the mapped domain shapes in
 * hostelworld-mapper.ts for the reason booking-types.ts gives: a schema change upstream is
 * caught at the mapping boundary rather than leaking deeper as an `any`.
 *
 * Captured 2026-09-04 from real requests for London (city 3), check-in 2026-10-09, three
 * nights, one guest, EUR, price-sorted — the acceptance trip's own stopover. Two fixtures
 * in `fixtures/hostelworld-*.json` are those responses, trimmed of the long marketing prose
 * and the image galleries but with every field this adapter reads left intact.
 *
 * Only what the adapter reads is modelled. Everything is optional, because none of it is a
 * contract anyone owes us.
 */

/** One city from `GET /2.2/continents/{continentId}/countries/`, with real coordinates.
 *
 * The coordinates are the point of this endpoint. Hostelworld's autocomplete service also
 * returns cities, but it sends `{latitude: 0, longitude: 0}` on every entry AND no
 * `Access-Control-Allow-Origin` to a foreign origin, so it is unusable twice over — see
 * hostelworld-client.ts's header. Matching a city to an airport by distance is both keyless
 * and exact, where matching by name is neither. */
export interface HostelworldGeoCity {
	id?: number;
	name?: string;
	/** Sent as a number here (the properties endpoint sends them as numbers too; only the
	 * `/2.2/cities/` stub sends strings), but validated rather than trusted. */
	latitude?: number;
	longitude?: number;
}

/** `GET /2.2/continents/{1..6}/countries/` — one continent's countries, each with its full
 * city list. Six of these cover the world: 167 countries, 3541 cities, 83 KB gzipped. */
export interface HostelworldContinentCountriesResponse {
	countries?: { id?: number; name?: string; cities?: HostelworldGeoCity[] }[];
}

/** A price as Hostelworld sends it: major units as a DECIMAL STRING, never a number.
 * hostelworld-mapper.ts's `toMoney` parses the digits directly rather than going through
 * `Number()` and a multiply — see its comment for why. */
export interface HostelworldPrice {
	value?: string;
	currency?: string;
}

/** One room type at a property, from `rooms.dorms` / `rooms.privates` (`show-rooms=1`).
 *
 * Read for exactly one thing: the female-dorm price, which no property-level field
 * carries. `basicType` is a real structured value in Hostelworld's own taxonomy —
 * "Mixed Dorm", "Female Dorm", "Private", "Dbl Private" — unlike Agoda's `isDormitory`
 * flag, which agoda-types.ts records as `false` on rooms literally named "N-Bed
 * Dormitory". */
export interface HostelworldRoom {
	name?: string;
	basicType?: string;
	/** Per night, averaged across the stay, for this one room type. Confirmed per-night,
	 * not per-stay: asking for 1 night and for 3 nights returns different values for the
	 * same room (63.56 vs 53.91 at Wombat's London, 2026-09-04), which a per-stay total
	 * could not do. */
	averagePrice?: HostelworldPrice;
}

/** One property from `GET /legacy-hwapi-service/2.2/cities/{cityId}/properties/`. */
export interface HostelworldProperty {
	id?: number;
	name?: string;
	latitude?: number;
	longitude?: number;
	/** 'HOSTEL', 'HOTEL', 'BNB', 'APARTMENT'. Passed through, not filtered on: the query
	 * asks for the cheapest bed near a coordinate, and a cheap airport hotel is a valid
	 * answer to that. */
	type?: string;
	overallRating?: {
		/** Out of 100 (a live Wombat's London scored 91). Carried through raw on that scale
		 * with `outOf: 100` beside it, per domain/stay.ts's `PropertyRating`: providers
		 * disagree on out-of-5 vs out-of-10 vs out-of-100, so the number is only meaningful
		 * with its scale attached.
		 *
		 * Zero means unrated, not nought out of a hundred (issue #245) — see
		 * `hostelworld-mapper.ts` for the measurement that settles that. */
		overall?: number;
	};
	/**
	 * The cheapest SINGLE night in the stay, not the stay's per-night cost — a "from"
	 * teaser. At Rest Up London for 9-12 October it reads 12.32 while the stay really
	 * averages 19.07 a night. Modelled so this file can say plainly that it is the wrong
	 * field; hostelworld-mapper.ts reads `lowestAverage*` instead. Using this one would
	 * have under-reported a three-night bed by 35%.
	 */
	lowestDormPricePerNight?: HostelworldPrice;
	lowestPrivatePricePerNight?: HostelworldPrice;
	/** The stay's actual cost per night, averaged over the nights asked for — this is what
	 * `nights × pricePerNight` has to equal for `Stay` to mean anything. Confirmed
	 * per-night by asking for one night, where it collapses to the same value as the
	 * `lowest*` field above (46.78 both, Wombat's City Hostel London, 2026-09-04). A
	 * per-stay total could not do that. */
	lowestAverageDormPricePerNight?: HostelworldPrice;
	lowestAveragePrivatePricePerNight?: HostelworldPrice;
	rooms?: {
		dorms?: HostelworldRoom[];
		privates?: HostelworldRoom[];
	};
	/** `{prefix, suffix}` halves of a URL with the scheme and the dot missing, e.g.
	 * `a.hwstatic.com/propertyimages/8/88047/k8pspacni1k2krc0boap` + `.jpg`.
	 * hostelworld-mapper.ts joins them and prepends `https://`; confirmed 200 image/jpeg. */
	images?: { prefix?: string; suffix?: string }[];
}

export interface HostelworldPropertiesResponse {
	properties?: HostelworldProperty[];
}

/* The body Hostelworld sends with a 4xx — `{"description":[{"code":"90593","message":
 * "please pass valid currency three letter code"}]}` for `currency=CVE`, observed
 * 2026-09-04 — is no longer modelled here. `../response-evidence.ts` reads it, along with
 * every other error shape this repo has measured, so one module knows all of them instead
 * of each adapter re-deriving its own. */

/** Failure modes of one HTTP call to Hostelworld. Narrower than `ProviderError`
 * (../types.ts) — the same split ryanair-types.ts and booking-types.ts make, mapped up to
 * that shared union at the adapter boundary.
 *
 * No `not-subscribed` member, unlike Booking's: there is no subscription, no key and no
 * account. Nothing this adapter can fail with is something a user could fix by pasting
 * something, so no failure here may ever be reported as a missing key. */
export type HostelworldFetchError =
	| { code: 'cancelled'; message: string }
	| { code: 'network-error'; message: string; cause?: unknown }
	| { code: 'malformed-response'; message: string; cause?: unknown }
	| { code: 'rate-limited'; message: string; retryAfterSeconds?: number }
	| { code: 'http-error'; message: string; status: number };

export type HostelworldFetchResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: HostelworldFetchError };
