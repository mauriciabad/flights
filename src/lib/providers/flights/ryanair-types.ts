/**
 * Raw shapes returned by Ryanair's own public endpoints (undocumented, unversioned — this
 * project is not a partner). Kept separate from the mapped domain shapes in
 * ryanair-mapper.ts so a future schema change on Ryanair's side is caught at the mapping
 * boundary instead of an `any` leaking deeper into the adapter.
 *
 * Captured 2026-09-04 from real responses (see the PR body for the exact requests) —
 * re-verify before trusting a field that isn't exercised by a fixture in ./fixtures/.
 */

export interface RyanairPrice {
	value: number;
	valueMainUnit: string;
	valueFractionalUnit: string;
	currencyCode: string;
	currencySymbol: string;
}

/**
 * One calendar day of the `cheapestPerDay` response — the cheapest fare Ryanair will sell
 * on that day, or a row saying there is nothing to sell.
 *
 * Every field except `day` goes null together on a day with no flight, and the response
 * always covers the whole calendar month whatever date range was asked for, so a caller
 * has to both filter these out and clip to its own window.
 *
 * What this row does NOT carry is the reason `ryanair-mapper.ts` joins it against the
 * timetable feed below: no flight number, no carrier code, and no airport objects. The
 * airports are known from the request; the flight's identity is not.
 *
 * ## It also does not say when Ryanair last moved the price (issue #170)
 *
 * Worth stating outright, because the app used to imply otherwise and the answer took a
 * live measurement to settle. Every field on a fare row is listed above; measured against
 * the live endpoint on 2026-09-04, the union of keys across all 31 rows of a
 * `BCN/STN/cheapestPerDay` response is exactly `day`, `arrivalDate`, `departureDate`,
 * `price`, `soldOut`, `unavailable`. There is no reprice timestamp, and
 * ./fixtures/cheapest-per-day-bcn-stn.json is a verbatim capture, not a trimmed one.
 *
 * Three places it could have come from, all closed:
 *
 * - **The old fare finder.** `farfnd/v4/oneWayFares` does carry `priceUpdated` (epoch
 *   millis, past-dated; re-checked live 2026-09-04, and it read 3.5 hours behind the
 *   clock at the time). It is not this endpoint. Issue #137 replaced it precisely because
 *   pinned to one route it answers `size: 1` — a single fare for the entire month — so
 *   its one timestamp could describe at most one of the thirty-one dated offers the
 *   flight picker now shows, at the cost of a third request per route-month. One honest
 *   date on one card, thirty cards still undated, and a request spent per search to get
 *   there.
 * - **Ryanair's CDN.** The wire response does carry CloudFront `age` and `date`, which
 *   together say how long the answer sat in the cache. A browser cannot read either:
 *   neither is CORS-safelisted, and Ryanair's `Access-Control-Expose-Headers` names only
 *   `Content-Type, Accept, X-Requested-With, X-File-Name, x-real-ip, Market-Code,
 *   Market-BasePath, X-AUTH-TOKEN, X-Session-Token, fr-correlation-id`. Confirmed from a
 *   real cross-origin fetch in Chromium on 2026-09-04: the only readable headers on this
 *   response are `cache-control` and `content-type`, and `res.headers.get('age')` is
 *   `null`. This app has no backend to read them from anywhere else.
 * - **`Cache-Control: max-age=60, s-maxage=300`.** Readable, but it is the CDN's
 *   retention policy, not a statement about when the price changed. Reading a repricing
 *   instant out of it would be the invention this issue exists to prevent.
 *
 * So the honest position is that this adapter does not know when a fare was last
 * repriced, and nothing downstream may imply it does. `results/view-model.ts` says
 * "Checked 40 minutes ago" rather than "Priced 40 minutes ago" for that reason.
 */
export interface RyanairDailyFare {
	/** Calendar date, "2026-10-01". Present on every row, including unsellable ones. */
	day: string;
	/** Wall-clock local time at the DEPARTURE airport, no zone suffix, e.g.
	 * "2026-10-01T05:45:00". See ryanair-timezone.ts for why this needs a separate lookup
	 * to become a domain LocalDateTime. Null on a day with no flight. */
	departureDate: string | null;
	/** Same shape, but local to the ARRIVAL airport. Null on a day with no flight. */
	arrivalDate: string | null;
	price: RyanairPrice | null;
	/** The flight exists but every seat at this fare is gone. */
	soldOut: boolean;
	/** Nothing is on sale this day. Measured 2026-09-04: this is also what a route Ryanair
	 * does not fly AT ALL looks like — BCN→OTP and BVC→LGW both answer `200` with 31
	 * `unavailable: true` rows. Unlike the per-airport routes endpoint issue #121 deleted,
	 * there is no 404 here to lean on. A caller that ignores this flag would invent a month
	 * of flights on a route the airline does not operate, which docs/ACCEPTANCE.md calls the
	 * highest-severity bug in the repo. */
	unavailable: boolean;
}

export interface RyanairCheapestPerDayResponse {
	outbound: {
		fares: RyanairDailyFare[];
		minFare: RyanairDailyFare | null;
		maxFare: RyanairDailyFare | null;
	};
}

/** One scheduled flight in the monthly timetable. `number` carries NO carrier prefix
 * ("846"), unlike the fare finder's old `flightNumber` ("FR8231") — the prefix is
 * `carrierCode`, and the two are joined back together in ryanair-mapper.ts. */
export interface RyanairScheduledFlight {
	/** Operating carrier's IATA code. Usually "FR", but measured "RK" (Ryanair UK) on
	 * STN→DUB, 2026-09-04 — which is exactly why nothing downstream may hardcode "FR". */
	carrierCode: string;
	number: string;
	/** Wall-clock "HH:MM" at the departure airport. */
	departureTime: string;
	/** Wall-clock "HH:MM" at the arrival airport. */
	arrivalTime: string;
}

/** `day` is the day of the month (1-31), not a date string. Only days that actually have
 * a flight appear at all, so this array is usually shorter than the month. */
export interface RyanairScheduleDay {
	day: number;
	flights: RyanairScheduledFlight[];
}

/** A route Ryanair does not fly answers `200 {"month":10,"days":[]}`. */
export interface RyanairMonthlyScheduleResponse {
	month: number;
	days: RyanairScheduleDay[];
}

// The per-airport route endpoint's own response shape used to be modelled here.
// Issue #121 deleted it along with the calls: `/views/locate/searchWidget/routes/en/
// airport/{IATA}` answers for one airport what the active-airports response below
// answers for all 224 at once, and asking it per airport cost 80 requests on a single
// BCN->OTP search. Nothing in this adapter fetches it any more, so there is no raw shape
// left to model.

export interface RyanairActiveAirport {
	iataCode: string;
	name: string;
	seoName: string;
	aliases: string[];
	coordinates: { latitude: number; longitude: number };
	base: boolean;
	countryCode: string;
	regionCode?: string;
	cityCode: string;
	macCityCode?: string;
	currencyCode: string;
	/** Every destination this airport connects to, each entry prefixed by what it names:
	 * `airport:STN`, `city:LONDON`, `country:it`, `region:ENGLAND`, `connectingFlight:...`.
	 * Only the `airport:` entries are routes to one specific airport, and together across
	 * all 224 airports they are Ryanair's entire route graph — see `buildNetworkSnapshot`
	 * in ryanair-mapper.ts, and issue #121 for why that matters. */
	routes?: string[];
	/** Same encoding as `routes`. Empty on every airport as of 2026-09-04; `routes`
	 * already includes seasonal destinations. */
	seasonalRoutes?: string[];
	categories?: string[];
	priority?: number;
	/** IANA zone name, e.g. "Europe/Madrid" — one of the two reasons this adapter fetches
	 * this endpoint: neither the fare calendar nor the timetable above carries a zone. */
	timeZone: string;
}

export type RyanairActiveAirportsResponse = RyanairActiveAirport[];

/**
 * Failure modes of a single HTTP call to a Ryanair endpoint. Distinct from and narrower
 * than `ProviderError` (src/lib/providers/types.ts): Ryanair is keyless, so there is no
 * `missing-key`/`not-subscribed` case here, and `rate-limited` maps onto
 * `quota-exceeded` at the adapter boundary rather than being named the same thing here,
 * since a 429 from Ryanair's own WAF is not RapidAPI quota even though the HTTP shape
 * matches.
 */
export type RyanairFetchError =
	| { code: 'cancelled'; message: string }
	| { code: 'network-error'; message: string; cause?: unknown }
	| { code: 'malformed-response'; message: string; cause?: unknown }
	| { code: 'rate-limited'; message: string; status: 429; retryAfterSeconds?: number }
	| { code: 'http-error'; message: string; status: number };

export type RyanairFetchResult<T> = { ok: true; data: T } | { ok: false; error: RyanairFetchError };
