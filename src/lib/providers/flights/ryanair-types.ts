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

export interface RyanairRouteEntry {
	arrivalAirport: {
		code: string;
		name: string;
		seoName: string;
		aliases: string[];
		base: boolean;
		city: { name: string; code: string; macCode?: string };
		region?: { name: string; code: string };
		country: {
			code: string;
			iso3code: string;
			name: string;
			currency: string;
			defaultAirportCode: string;
			schengen: boolean;
		};
		coordinates: { latitude: number; longitude: number };
		timeZone: string;
	};
	recent: boolean;
	seasonal: boolean;
	/** IATA carrier code operating the route, e.g. "FR" for Ryanair itself, but this
	 * endpoint also lists routes operated by Ryanair group carriers (e.g. "RK" for
	 * Ryanair UK, "FR" covers the vast majority). Not filtered on here — see
	 * ryanair-mapper.ts `mapRoutesToDestinations` for why. */
	operator: string;
	tags: string[];
}

export type RyanairRoutesResponse = RyanairRouteEntry[];

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
	routes?: string[];
	seasonalRoutes?: string[];
	categories?: string[];
	priority?: number;
	/** IANA zone name, e.g. "Europe/Madrid" — the reason this adapter fetches this endpoint
	 * at all: the fare-finder response above has no timezone field of its own. */
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
