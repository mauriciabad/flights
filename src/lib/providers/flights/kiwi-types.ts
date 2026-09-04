/**
 * Raw shapes for the "Kiwi.com Cheap Flights" RapidAPI listing
 * (`kiwi-com-cheap-flights.p.rapidapi.com`, `rapidapi.com/emir12/api/kiwi-com-cheap-flights`
 * — issue #51).
 *
 * A caveat this file's siblings (ryanair-types.ts etc.) don't need to carry: the response
 * shape below was never confirmed against a live payload. Every call made while building
 * this adapter — both `/one-way` and `/round-trip`, after a real $0 BASIC-plan subscription
 * with a working key — returned `402 {"error":{"code":"402","message":"Payment required"}}`
 * with a `x-vercel-error: DEPLOYMENT_DISABLED` response header. That header is Vercel's own
 * marker for a serverless deployment its owner has taken offline; RapidAPI's gateway still
 * proxies the request through to it (a genuine `x-rapidapi-request-id` comes back), so this
 * is the listing's own backend being down, not a subscription or key problem. See kiwi.ts's
 * header comment and the PR for the full story.
 *
 * The request shape (every field on `KiwiOneWaySearchParams`) is NOT a guess: it comes
 * straight from RapidAPI's own code-snippet generator for this endpoint, which is static
 * documentation independent of the backend being reachable. The response shape below is
 * reconstructed instead from the historical public Kiwi/Skypicker search API this family of
 * "Kiwi flights scraper" RapidAPI listings wraps (github.com/SScorp/Skypicker-apiary is the
 * last surviving public spec for it) — the closest verifiable source available while the
 * live endpoint stays dead. Re-verify every field name here against a real response before
 * trusting this adapter in production: capture one live payload once the deployment is back
 * (or once a working alternative listing is chosen), then update this file and the fixtures
 * in ./fixtures/ to match whatever actually comes back.
 */

/** Query parameters for the `/one-way` endpoint, exactly as named in RapidAPI's generated
 * cURL snippet. Only the subset this adapter actually sets; the endpoint accepts ~30. */
export interface KiwiOneWaySearchParams {
	/** IATA airport code, e.g. "BCN". The endpoint's own param docs only show
	 * "Country:GB"/"City:dubrovnik_hr"-style examples, but a bare, unprefixed code was
	 * accepted at the request-validation stage in this adapter's one live test (the
	 * request reached the upstream and failed there with 402, not with a 400 for a bad
	 * `source`), which is the only evidence available while the backend stays down. */
	source: string;
	/** Omitted entirely for `listDirectDestinations` — the docs mark this "Optional",
	 * which is what makes an "everywhere from this airport" search possible at all. */
	destination?: string;
	/** `YYYY-MM-DDTHH:mm:ss`, local to the departure airport, no zone suffix. */
	outboundDepartmentDateStart: string;
	outboundDepartmentDateEnd: string;
	/** Lowercase ISO 4217, e.g. "eur". */
	currency: string;
	adults: number;
	handbags: number;
	holdbags: number;
	/** Always sent true: without it Kiwi may restrict connections to interline pairs on
	 * affiliated carriers, which would hide exactly the self-transfer data issue #51 asks
	 * this adapter to investigate. */
	enableSelfTransfer: boolean;
	/** Always sent true, for the same reason as `enableSelfTransfer` — this is the flag
	 * that lets a self-transfer combination span more than a same-day connection. See
	 * kiwi.ts's design-question section for what "overnight" turned out to mean in
	 * practice (not the multi-day gap this app needs). */
	allowOvernightStopover: boolean;
	/** 0 restricts to nonstop itineraries — how `listDirectDestinations` asks for direct
	 * routes only. Omitted (not 0) for an ordinary `searchOffers` call, which wants
	 * connections too. */
	maxStopsCount?: number;
	limit: number;
}

/** One real flight within an itinerary's `route` array. */
export interface KiwiRouteSegment {
	id: string;
	flyFrom: string;
	flyTo: string;
	cityFrom?: string;
	cityTo?: string;
	/** IATA carrier code, e.g. "FR". */
	airline: string;
	flight_no: number;
	/** Local wall-clock time at the departure airport, encoded as a Unix timestamp in
	 * seconds as though that wall-clock reading were itself UTC — Kiwi's own long-standing
	 * convention (the apiary spec: "do not convert the time between time zones"). Never
	 * used for duration maths directly; see kiwi-timezone.ts, which pairs this with
	 * `dTimeUTC` to get both the correct local clock reading and the correct offset with
	 * no timezone database lookup needed. */
	dTime: number;
	aTime: number;
	/** The real UTC instant, in Unix seconds, for the same moment as `dTime`/`aTime`. */
	dTimeUTC: number;
	aTimeUTC: number;
	/** This leg's own price, in the response's top-level `currency`. Present because a
	 * bundled itinerary still has to price each leg individually (Kiwi substitutes a
	 * self-transfer leg if one sells out, which needs a per-leg price). Optional because
	 * the historical spec shows it can be absent; treated as "drop this leg" rather than
	 * guessed at zero when missing — see kiwi-mapper.ts. */
	price?: number;
	/** 0 for an outbound-direction segment, 1 for a return-direction one. This adapter
	 * only ever issues one-way searches, so every segment here should read 0 — kept as a
	 * defensive filter in the mapper rather than assumed. */
	return: 0 | 1;
	/** True when the passenger must reclaim and re-check bags between this segment and
	 * the next: Kiwi's own signal that the connection is NOT a single ticket across
	 * affiliated carriers, i.e. this is a self-transfer / virtual-interlining join. See
	 * kiwi.ts's design-question section for how this adapter treats it. */
	bags_recheck_required?: boolean;
}

/** One priced itinerary: one or more `route` segments sold together. */
export interface KiwiItinerary {
	id: string;
	/** Combined price for every segment in `route`, in the response's top-level
	 * `currency`. NOT used for the per-segment FlightOffers this adapter emits — see
	 * kiwi-mapper.ts for why a bundle price is the wrong number for a single leg. */
	price: number;
	/** Present on a real response; absent isn't treated as an error since neither field
	 * is needed to build a FlightOffer for an individual leg (see kiwi-mapper.ts). */
	booking_token?: string;
	deep_link?: string;
	/** One entry per real flight. Length 1 for a nonstop itinerary; length > 1 for a
	 * connecting one, self-transfer or otherwise. */
	route: KiwiRouteSegment[];
}

export interface KiwiOneWayResponse {
	/** ISO 4217 currency code, lowercase in Kiwi's own responses (e.g. "eur"). */
	currency: string;
	data: KiwiItinerary[];
}

/**
 * Failure modes of a single HTTP call to this adapter's endpoints. A superset of
 * Ryanair's equivalent union (ryanair-types.ts `RyanairFetchError`) because Kiwi is a
 * metered RapidAPI listing, not a keyless one: `missing-key` and `not-subscribed` are real
 * cases here that Ryanair never has.
 */
export type KiwiFetchError =
	| { code: 'missing-key'; message: string }
	| { code: 'cancelled'; message: string }
	| { code: 'network-error'; message: string; cause?: unknown }
	| { code: 'malformed-response'; message: string; cause?: unknown }
	| { code: 'not-subscribed'; message: string; status: 403 }
	| { code: 'rate-limited'; message: string; status: 429; retryAfterSeconds?: number }
	/** Covers every other non-2xx, including the 402 this adapter's own listing returns
	 * while its backend is down (`x-vercel-error: DEPLOYMENT_DISABLED`) — that is an
	 * upstream outage, not a shape this adapter recognises as anything more specific. */
	| { code: 'http-error'; message: string; status: number };

export type KiwiFetchResult<T> = { ok: true; data: T } | { ok: false; error: KiwiFetchError };
