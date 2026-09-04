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

export interface RyanairFareFinderAirport {
	countryName: string;
	iataCode: string;
	name: string;
	seoName: string;
	city: { code: string; countryCode: string; name: string; macCode?: string };
}

export interface RyanairFare {
	outbound: {
		departureAirport: RyanairFareFinderAirport;
		arrivalAirport: RyanairFareFinderAirport;
		/** Wall-clock local time at the departure airport, no zone suffix, e.g.
		 * "2026-10-13T09:10:00". See ryanair-timezone.ts for why this needs a separate
		 * lookup to become a domain LocalDateTime. */
		departureDate: string;
		/** Same shape as departureDate, but local to the arrival airport. */
		arrivalDate: string;
		price: RyanairPrice;
		flightKey: string;
		/** e.g. "FR8231" — carrier prefix already included. */
		flightNumber: string;
		previousPrice: RyanairPrice | null;
		priceUpdated: number;
	};
	summary: { price: RyanairPrice; previousPrice: RyanairPrice | null; newRoute: boolean };
}

export interface RyanairOneWayFaresResponse {
	arrivalAirportCategories: unknown;
	fares: RyanairFare[];
	nextPage: string | null;
	size: number;
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
	 * this endpoint: the fare-finder response above has no timezone field of its own. */
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
