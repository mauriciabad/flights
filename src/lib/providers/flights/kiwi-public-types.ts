/**
 * Raw response shapes for Kiwi.com's public GraphQL endpoint
 * (`api.skypicker.com/umbrella/v2/graphql`), captured live on 2026-09-04 — see
 * ./fixtures/kiwi-public-*.json for the exact payloads these describe, and
 * docs/PROVIDERS.md for how they were measured.
 *
 * These interfaces are a record of what one set of real responses looked like, not a
 * contract Kiwi has published. Nothing here is validated by the type system at runtime:
 * kiwi-public-mapper.ts re-checks every leaf value it reads, same discipline
 * ryanair-mapper.ts adopted after issue #93 found `Number.parseInt` quietly turning a
 * renamed field into a `NaN` price that flowed all the way into an itinerary total.
 *
 * Every field below is optional on purpose. This is an undocumented endpoint belonging to
 * someone else's website, so a field disappearing is a normal thing to survive, not an
 * exceptional one to crash on.
 */

/** `{ code: "BY", name: "TUI Airways" }`. */
export interface KiwiPublicCarrier {
	code?: string;
	name?: string;
}

/** Kiwi's own IANA zone for the airport, which is the reason this adapter needs no
 * Transitous lookup at all (contrast skyscanner-timezone.ts, which exists purely because
 * Sky Scrapper sends bare local strings with no zone). */
export interface KiwiPublicStation {
	code?: string;
	timezone?: string;
	type?: string;
}

/** One end of a segment. `localTime` is a wall-clock string with no zone suffix
 * ("2026-10-06T12:40:00"); the zone that reading belongs to is on `station.timezone`. */
export interface KiwiPublicStop {
	localTime?: string;
	station?: KiwiPublicStation;
}

/** `code` is the flight number WITHOUT the carrier prefix ("259", not "BY259") — the two
 * are concatenated in the mapper. `duration` is in SECONDS (measured: BVC→LGW came back
 * as 21000, and 21000 / 60 = 350 minutes = the 5h50m between its own local times). */
export interface KiwiPublicSegment {
	code?: string;
	duration?: number;
	carrier?: KiwiPublicCarrier;
	source?: KiwiPublicStop;
	destination?: KiwiPublicStop;
	/**
	 * Kiwi's own answer to "does the passenger stay on the plane after this segment", and
	 * the reason issue #210 did not have to settle for guessing from flight numbers.
	 *
	 * Found by introspecting the live schema on 2026-09-04 (`__type(name: "Segment")`),
	 * where it is declared `followingTechnicalStop: Boolean` with no description. The name
	 * reads either way, so the semantics were taken from a real response rather than from
	 * the name: on Neos NO4864 BVC→SID→FCO the FIRST segment (BVC→SID) carries `true` and
	 * the second (SID→FCO) carries `false`. So it describes the stop that FOLLOWS this
	 * segment, and the last segment of an itinerary is always `false` because nothing
	 * follows it.
	 *
	 * Undocumented like everything else here, hence optional: `kiwi-public-mapper.ts` falls
	 * back to the carrier-plus-flight-number rule when it is absent, and never treats
	 * absence as `true`.
	 */
	followingTechnicalStop?: boolean;
}

export interface KiwiPublicSectorSegment {
	segment?: KiwiPublicSegment;
}

export interface KiwiPublicSector {
	sectorSegments?: KiwiPublicSectorSegment[];
}

/** `amount` is a decimal string ("173", possibly "173.50"), never a number, so it is
 * parsed digit-wise into `Money`'s integer minor units rather than through a float. */
export interface KiwiPublicMoney {
	amount?: string;
	currency?: { code?: string };
}

/** Real included-baggage counts, unlike Ryanair's fare finder which says nothing about
 * baggage and forces ryanair-mapper.ts to hardcode the Basic-fare allowance. */
export interface KiwiPublicBagsInfo {
	includedCheckedBags?: number;
	includedHandBags?: number;
}

export interface KiwiPublicItinerary {
	id?: string;
	price?: KiwiPublicMoney;
	bagsInfo?: KiwiPublicBagsInfo;
	sector?: KiwiPublicSector;
}

/**
 * `onewayItineraries` resolves a union. `__typename` is `"Itineraries"` on success and
 * `"AppError"` on a handled failure, where the message is aliased to `error` by the query
 * document. AGENTS.md is explicit that a provider's own message must be surfaced verbatim
 * rather than replaced by a guess, so that alias is read and passed through untouched.
 */
export interface KiwiPublicItinerariesResult {
	__typename?: string;
	error?: string;
	itineraries?: KiwiPublicItinerary[];
}

/** One entry per reachable destination city, from `onewayOnePerCityItineraries`. Only the
 * station code is asked for: this query backs `listDirectDestinations`, which answers
 * "which airports can sit in the middle", not "what does it cost". */
export interface KiwiPublicOnePerCityItinerary {
	destination?: { station?: KiwiPublicStation };
}

export interface KiwiPublicOnePerCityResult {
	__typename?: string;
	error?: string;
	itineraries?: KiwiPublicOnePerCityItinerary[];
}

export interface KiwiPublicGraphQlResponse<T> {
	data?: T;
	/** Transport-level GraphQL errors, distinct from the `AppError` union member above:
	 * these mean the query itself was rejected (a renamed field, a changed input type),
	 * which is an adapter bug rather than "no flights found". */
	errors?: { message?: string }[];
}

export interface KiwiPublicOneWayData {
	onewayItineraries?: KiwiPublicItinerariesResult;
}

export interface KiwiPublicOnePerCityData {
	onewayOnePerCityItineraries?: KiwiPublicOnePerCityResult;
}

/** Mirrors `RyanairFetchError`: the client layer's own failure vocabulary, translated to
 * `ProviderError` by kiwi-public.ts. Kept separate so the client never has to import the
 * provider interface just to report that a fetch failed. */
export type KiwiPublicFetchError =
	| { code: 'cancelled'; message: string }
	| { code: 'network-error'; message: string; cause?: unknown }
	| { code: 'malformed-response'; message: string; cause?: unknown }
	| { code: 'rate-limited'; message: string; retryAfterSeconds?: number }
	| { code: 'http-error'; message: string; status: number };

export type KiwiPublicFetchResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: KiwiPublicFetchError };
