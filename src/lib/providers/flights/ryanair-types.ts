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
