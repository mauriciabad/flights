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
 */

import type { BaggageAllowance, Carrier, FlightOffer, IataAirportCode, Money } from '../../domain';
import { computeFlightDuration, toLocalDateTime } from './kiwi-timezone';
import type { KiwiItinerary, KiwiOneWayResponse, KiwiRouteSegment } from './kiwi-types';

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
 * Maps one raw route segment to a domain `FlightOffer`. Returns `undefined` when the
 * segment has no price at all (kiwi-types.ts documents this as possible on the historical
 * spec) — dropping one unpriced leg rather than guessing a price, per AGENTS.md "say what
 * you do not know rather than guessing."
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
 * nonstop leg without re-deriving this from `route.length` itself. */
export function isSelfTransferItinerary(itinerary: KiwiItinerary): boolean {
	return itinerary.route.length > 1 || itinerary.route.some((segment) => segment.bags_recheck_required === true);
}

/** Maps every real, forward-direction segment of one itinerary. Skips the whole itinerary
 * when it has no booking link at all (see `mapSegmentToFlightOffer`'s header), and skips
 * any individual segment whose own `return` flag reads 1 — this adapter only ever issues
 * one-way searches, so that should never happen, but the flag exists precisely to tell a
 * return-direction leg apart from an outbound one and dropping a misfiled one is cheaper
 * than mapping a flight this app didn't ask for. */
export function mapItineraryToFlightOffers(
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
 * must resolve — every segment of every itinerary, in response order. */
export function mapResponseToFlightOffers(
	response: KiwiOneWayResponse,
	requestedBags: KiwiRequestedBags,
	countryCodeByIataCode: Readonly<Record<string, string>>
): FlightOffer[] {
	const offers: FlightOffer[] = [];
	for (const itinerary of response.data) {
		offers.push(...mapItineraryToFlightOffers(itinerary, response.currency, requestedBags, countryCodeByIataCode));
	}
	return offers;
}

/** Every distinct airport IATA code mentioned anywhere in a response — what kiwi.ts uses
 * to build `countryCodeByIataCode` (via this app's own airport dataset,
 * src/lib/data/airports.ts) before calling the mapping functions above, since this file
 * itself must stay I/O-free. */
export function collectIataCodes(response: KiwiOneWayResponse): IataAirportCode[] {
	const codes = new Set<string>();
	for (const itinerary of response.data) {
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
 * different dates in the search window. */
export function mapResponseToDirectDestinations(response: KiwiOneWayResponse): IataAirportCode[] {
	const codes = new Set<string>();
	for (const itinerary of response.data) {
		if (itinerary.route.length !== 1) continue;
		const [segment] = itinerary.route;
		if (segment?.flyTo) codes.add(segment.flyTo);
	}
	return Array.from(codes);
}
