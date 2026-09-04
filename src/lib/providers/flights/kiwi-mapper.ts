/**
 * Pure translation from Kiwi's raw response shapes (kiwi-types.ts) to this app's domain
 * shapes (src/lib/domain). No I/O, no cache, no fetch — same discipline as
 * ryanair-mapper.ts, so kiwi-mapper.test.ts runs entirely off ./fixtures/ with no network.
 *
 * The one deliberate choice worth stating up front, since issue #51 asked for it in so
 * many words: this file maps each of an itinerary's `route` segments to its OWN
 * `FlightOffer`, never the itinerary as a whole to one. Domain's `FlightOffer` (see
 * flight-offer.ts) models exactly one real flight — one carrier, one flight number, one
 * departure/arrival pair — and a Kiwi self-transfer itinerary can bundle two or three of
 * those under one combined price. Collapsing that bundle into a single `FlightOffer` would
 * either invent a fake "flight number" for a trip that never has one, or silently keep
 * only the first leg and throw the rest away — both are the flattening issue #51 explicitly
 * says not to do. Mapping every segment keeps every real flight (its own carrier, price,
 * and timezone-aware duration) intact; what is genuinely lost by not modelling the bundle
 * itself is Kiwi's combined price and its single shared booking link, because domain has no
 * "bundled multi-leg offer" concept yet for either to live on. `isSelfTransferItinerary`
 * below exposes the signal that a bundle existed, so a future caller doesn't have to
 * re-derive it, without this file inventing a domain type that issue #51 doesn't own.
 *
 * The other thing every public function here does that Ryanair's and Skyscanner's mappers
 * don't: every entry point takes `unknown`, not a pre-typed `KiwiOneWayResponse`, and
 * validates every field it is about to read before reading it, throwing
 * `KiwiMalformedResponseError` on a mismatch (caught by kiwi.ts and turned into a
 * `malformed-response` ProviderError, same pattern as skyscanner-map-offers.ts's own
 * `SkyscannerMalformedResponseError`). Ryanair's and Skyscanner's shapes were captured off
 * real traffic; this adapter's (kiwi-types.ts's header) was reconstructed from Kiwi's
 * historical public schema because the live listing has answered 402/DEPLOYMENT_DISABLED
 * throughout this adapter's whole development. Plain field access on an unverified shape
 * is exactly how a schema drift turns into a wrong price reaching a traveller instead of
 * an error — AGENTS.md: "say what you do not know rather than guessing," and a caught
 * mismatch is that, an uncaught one is the opposite.
 *
 * One field failing validation fails the WHOLE response here, deliberately stricter than
 * Skyscanner's per-itinerary leniency (skyscanner-map-offers.ts drops one bad itinerary and
 * keeps the rest, reasonably, since its shape is a known-good baseline and a single odd row
 * is normal noise). This adapter has no verified baseline to compare against, so one
 * field not matching this file's assumptions is treated as evidence the whole batch of
 * assumptions may be wrong, not as one flaky row — a mix of "some offers mapped, some
 * silently didn't" is a worse failure mode here than refusing the whole response, because
 * nothing distinguishes a correctly-mapped offer from a coincidentally-still-parses one.
 */

import type { BaggageAllowance, Carrier, FlightOffer, IataAirportCode, Money } from '../../domain';
import { computeFlightDuration, toLocalDateTime } from './kiwi-timezone';
import type { KiwiItinerary, KiwiOneWayResponse, KiwiRouteSegment } from './kiwi-types';

/** Thrown by the `assertValid*` functions below when Kiwi's response doesn't have a field
 * this file is about to read, or that field has the wrong type. Exported so kiwi.ts can
 * catch it specifically and turn it into a `malformed-response` ProviderError, the same
 * relationship skyscanner.ts has with `SkyscannerMalformedResponseError`. */
export class KiwiMalformedResponseError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function fail(message: string): never {
	throw new KiwiMalformedResponseError(message);
}

/**
 * Validates every field `mapSegmentToFlightOffer` reads off one raw route segment. Not a
 * general-purpose schema check — deliberately narrow to what this file actually consumes,
 * per the brief this fix was written against: "no need for a schema library; explicit
 * checks on the fields you consume are enough."
 */
function assertValidRouteSegment(value: unknown): asserts value is KiwiRouteSegment {
	if (!isRecord(value)) fail('Kiwi route segment was not an object');
	if (typeof value.flyFrom !== 'string' || !value.flyFrom) fail('Kiwi route segment missing a string flyFrom');
	if (typeof value.flyTo !== 'string' || !value.flyTo) fail('Kiwi route segment missing a string flyTo');
	if (typeof value.airline !== 'string' || !value.airline) fail('Kiwi route segment missing a string airline');
	if (!isFiniteNumber(value.flight_no)) fail('Kiwi route segment missing a numeric flight_no');
	if (!isFiniteNumber(value.dTime) || !isFiniteNumber(value.aTime)) {
		fail('Kiwi route segment missing numeric dTime/aTime');
	}
	if (!isFiniteNumber(value.dTimeUTC) || !isFiniteNumber(value.aTimeUTC)) {
		fail('Kiwi route segment missing numeric dTimeUTC/aTimeUTC');
	}
	if (value.price !== undefined && !isFiniteNumber(value.price)) {
		fail('Kiwi route segment price was present but not numeric');
	}
	if (value.return !== 0 && value.return !== 1) fail('Kiwi route segment return flag was not 0 or 1');
	if (value.bags_recheck_required !== undefined && typeof value.bags_recheck_required !== 'boolean') {
		fail('Kiwi route segment bags_recheck_required was present but not a boolean');
	}
}

/** Validates one raw itinerary: its own `deep_link` field, then every segment in `route`. */
function assertValidItinerary(value: unknown): asserts value is KiwiItinerary {
	if (!isRecord(value)) fail('Kiwi itinerary was not an object');
	if (value.deep_link !== undefined && typeof value.deep_link !== 'string') {
		fail('Kiwi itinerary deep_link was present but not a string');
	}
	if (!Array.isArray(value.route)) fail('Kiwi itinerary missing a route array');
	for (const segment of value.route) assertValidRouteSegment(segment);
}

/**
 * Validates a full `/one-way` response: `currency`, `data`, and every itinerary in it.
 * Every public mapping function below calls this before reading anything, which is also
 * why each of them takes `unknown` rather than a pre-typed `KiwiOneWayResponse` — a
 * caller holding a value typed that way already trusted it once, and this file does not
 * repeat that trust.
 */
export function assertValidOneWayResponse(value: unknown): asserts value is KiwiOneWayResponse {
	if (!isRecord(value)) fail('Kiwi response was not an object');
	if (typeof value.currency !== 'string' || !value.currency) fail('Kiwi response missing a string currency');
	if (!Array.isArray(value.data)) fail('Kiwi response missing a data array');
	for (const itinerary of value.data) assertValidItinerary(itinerary);
}

/** What this adapter asked for, echoed back into every offer's `baggage` — the response
 * carries `bags_price`/`baglimit` (dimensions and per-extra-bag surcharges) but never a
 * plain "here is what's already included" count, so the only honest source for that count
 * is the request this adapter itself made (see kiwi.ts). */
export interface KiwiRequestedBags {
	handbags: number;
	holdbags: number;
}

/** Converts Kiwi's plain decimal price into `Money`'s integer minor units. Kiwi gives no
 * pre-split main/fractional strings the way Ryanair does (ryanair-mapper.ts `toMoney`), so
 * this is the ordinary `Math.round(price * 100)` — safe for a two-decimal currency, which
 * every currency this adapter's `currency` query param accepts is. */
function toMoney(price: number | undefined, currencyCode: string): Money | undefined {
	if (price === undefined) return undefined;
	return { minorUnits: Math.round(price * 100), currency: currencyCode.toUpperCase() };
}

/** Kiwi gives only the 2-letter carrier code, never an airline name, and this app has no
 * shared airline-name dataset the way it does for airports (src/lib/data/airports.ts).
 * Using the code as its own name is an honest stand-in, not a guess at a real name. */
function toCarrier(iataCode: string): Carrier {
	return { iataCode, name: iataCode };
}

/**
 * Maps one already-validated route segment to a domain `FlightOffer`. Returns `undefined`
 * when the segment has no price at all (kiwi-types.ts documents this as possible on the
 * historical spec) — dropping one unpriced leg rather than guessing a price, per AGENTS.md
 * "say what you do not know rather than guessing." This is a normal, documented absence,
 * not a shape violation, which is why it returns `undefined` here rather than being one of
 * `assertValidRouteSegment`'s checks above.
 */
export function mapSegmentToFlightOffer(
	segment: KiwiRouteSegment,
	currencyCode: string,
	requestedBags: KiwiRequestedBags,
	deepLink: string,
	countryCodeByIataCode: Readonly<Record<string, string>>
): FlightOffer | undefined {
	const price = toMoney(segment.price, currencyCode);
	if (!price) return undefined;

	const departure = toLocalDateTime(segment.dTime, segment.dTimeUTC, countryCodeByIataCode[segment.flyFrom]);
	const arrival = toLocalDateTime(segment.aTime, segment.aTimeUTC, countryCodeByIataCode[segment.flyTo]);

	const baggage: BaggageAllowance = {
		cabinBagsIncluded: requestedBags.handbags,
		checkedBagsIncluded: requestedBags.holdbags
	};

	return {
		carrier: toCarrier(segment.airline),
		flightNumber: `${segment.airline}${segment.flight_no}`,
		departureAirport: segment.flyFrom,
		arrivalAirport: segment.flyTo,
		departure,
		arrival,
		// From the true-UTC pair, never the local/fake-UTC one — a self-transfer leg can
		// cross a timezone boundary the same as any direct flight can.
		duration: computeFlightDuration(segment.dTimeUTC, segment.aTimeUTC),
		price,
		// Issue #109: kiwi.ts always requests `adults: 1` now, regardless of the real party
		// size, specifically so this can be `'per-person'` by construction rather than a
		// guess — Kiwi's backend has been down (402) since before this adapter's response
		// shape was confirmed live, so whether its price scales with `adults` at all could
		// not be measured. See kiwi.ts's own comment at that request for the full reasoning.
		priceScope: 'per-person',
		baggage,
		// Kiwi has no per-leg link once legs are bundled — this is the whole itinerary's
		// booking link, which still lands a traveller on a real bookable page for this
		// flight even though it is not leg-specific. See this file's header for why an
		// itinerary with no link at all is skipped rather than given an empty one.
		deepLink
	};
}

/** True when this itinerary combines more than one real flight, or explicitly marks a bag
 * re-check between two of them — Kiwi's own signal for a self-transfer /
 * virtual-interlining connection (this file's header, and kiwi.ts's design-question
 * section). Exposed so a caller can tell a Kiwi self-transfer combo apart from an ordinary
 * nonstop leg without re-deriving this from `route.length` itself. Takes an already-
 * validated `KiwiItinerary`, unlike the public entry points below, since it is always
 * called on one of `assertValidOneWayResponse`'s own validated `data` entries. */
export function isSelfTransferItinerary(itinerary: KiwiItinerary): boolean {
	return itinerary.route.length > 1 || itinerary.route.some((segment) => segment.bags_recheck_required === true);
}

/** Maps every real, forward-direction segment of one already-validated itinerary. Skips
 * the whole itinerary when it has no booking link at all (see `mapSegmentToFlightOffer`'s
 * header), and skips any individual segment whose own `return` flag reads 1 — this
 * adapter only ever issues one-way searches, so that should never happen, but the flag
 * exists precisely to tell a return-direction leg apart from an outbound one and dropping
 * a misfiled one is cheaper than mapping a flight this app didn't ask for. */
function mapItineraryToFlightOffers(
	itinerary: KiwiItinerary,
	currencyCode: string,
	requestedBags: KiwiRequestedBags,
	countryCodeByIataCode: Readonly<Record<string, string>>
): FlightOffer[] {
	if (!itinerary.deep_link) return [];
	const offers: FlightOffer[] = [];
	for (const segment of itinerary.route) {
		if (segment.return === 1) continue;
		const offer = mapSegmentToFlightOffer(
			segment,
			currencyCode,
			requestedBags,
			itinerary.deep_link,
			countryCodeByIataCode
		);
		if (offer) offers.push(offer);
	}
	return offers;
}

/** Maps a full `/one-way` response to the flat `FlightOffer[]` `FlightProvider.searchOffers`
 * must resolve — every segment of every itinerary, in response order. Throws
 * `KiwiMalformedResponseError` (see this file's header) if `raw` doesn't validate; callers
 * that want a `ProviderResult` instead, rather than a thrown error, catch it (kiwi.ts). */
export function mapResponseToFlightOffers(
	raw: unknown,
	requestedBags: KiwiRequestedBags,
	countryCodeByIataCode: Readonly<Record<string, string>>
): FlightOffer[] {
	assertValidOneWayResponse(raw);
	const offers: FlightOffer[] = [];
	for (const itinerary of raw.data) {
		offers.push(...mapItineraryToFlightOffers(itinerary, raw.currency, requestedBags, countryCodeByIataCode));
	}
	return offers;
}

/** Every distinct airport IATA code mentioned anywhere in a response — what kiwi.ts uses
 * to build `countryCodeByIataCode` (via this app's own airport dataset,
 * src/lib/data/airports.ts) before calling the mapping functions above, since this file
 * itself must stay I/O-free. Throws `KiwiMalformedResponseError` on the same terms as
 * `mapResponseToFlightOffers`. */
export function collectIataCodes(raw: unknown): IataAirportCode[] {
	assertValidOneWayResponse(raw);
	const codes = new Set<string>();
	for (const itinerary of raw.data) {
		for (const segment of itinerary.route) {
			codes.add(segment.flyFrom);
			codes.add(segment.flyTo);
		}
	}
	return Array.from(codes);
}

/** IATA codes reachable by a NONSTOP itinerary only (`route.length === 1`) — what
 * `listDirectDestinations` needs ("which airports this adapter has a DIRECT flight to",
 * types.ts), as opposed to every airport reachable via some connection, self-transfer or
 * otherwise. De-duplicated since the same nonstop route can appear more than once across
 * different dates in the search window. Throws `KiwiMalformedResponseError` on the same
 * terms as `mapResponseToFlightOffers`. */
export function mapResponseToDirectDestinations(raw: unknown): IataAirportCode[] {
	assertValidOneWayResponse(raw);
	const codes = new Set<string>();
	for (const itinerary of raw.data) {
		if (itinerary.route.length !== 1) continue;
		const [segment] = itinerary.route;
		if (segment?.flyTo) codes.add(segment.flyTo);
	}
	return Array.from(codes);
}
