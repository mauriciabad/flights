/**
 * Pure translation from Ryanair's raw response shapes (ryanair-types.ts) to this app's
 * domain shapes (src/lib/domain). No I/O, no cache, no fetch — everything here is a
 * function of its arguments, which is what makes ryanair-mapper.test.ts able to run
 * entirely off the fixtures in ./fixtures/ with no network.
 */

import type { BaggageAllowance, Carrier, FlightOffer, IataAirportCode, Money } from '../../domain';
import { computeFlightDuration, toLocalDateTime } from './ryanair-timezone';
import type { RyanairFare, RyanairOneWayFaresResponse, RyanairPrice, RyanairRoutesResponse } from './ryanair-types';

export const RYANAIR_CARRIER: Carrier = { iataCode: 'FR', name: 'Ryanair' };

/** The fare-finder endpoint never mentions baggage, because every fare it quotes is
 * Ryanair's lowest "Basic" bucket, which on Ryanair always means exactly one small
 * under-seat bag and nothing checked. Hardcoded rather than left undefined so a
 * baggage-aware scorer (issue #14) sees a real number for Ryanair instead of treating it
 * as unknown data — an assumption worth revisiting if this adapter ever grows fare-brand
 * selection beyond "whatever is cheapest." */
const BASIC_FARE_BAGGAGE: BaggageAllowance = { cabinBagsIncluded: 1, checkedBagsIncluded: 0 };

/**
 * Issue #93: `ryanair-types.ts`'s interfaces declare every field this file reads as a
 * plain `string`/`number`, but that is a compile-time hint about the shape this adapter
 * was built against, not a runtime guarantee about what Ryanair's undocumented endpoint
 * actually sends — the same gap issue #68 closed on every other adapter. The functions
 * below therefore re-check each leaf value at the point they read it, same discipline as
 * agoda-mapper.ts and booking-mapper.ts. Money is the sharpest case: the old
 * `Number.parseInt(price.valueMainUnit, 10)` silently returned `NaN` for a renamed or
 * retyped field, and `NaN` is a `number` that flows straight into an itinerary total with
 * no error and no throw. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** True when `value` is a wall-clock ISO string `toLocalDateTime` (ryanair-timezone.ts)
 * can parse without throwing. Checked here, before that call, rather than letting its
 * internal `Date.parse` throw a `RangeError`: that throw is not caught anywhere between
 * here and `mapFaresToFlightOffers`'s loop, so one fare with a garbled or missing date
 * string would otherwise take down the whole batch instead of being the one fare this
 * file drops. */
function isParsableLocalIsoString(value: unknown): value is string {
	return isNonEmptyString(value) && !Number.isNaN(Date.parse(`${value}Z`));
}

/** Converts Ryanair's price to `Money`'s integer minor units using the two pre-split
 * decimal strings rather than `value` itself — `14.99 * 100` is not reliably `1499` in
 * floating point, and `valueMainUnit`/`valueFractionalUnit` exist precisely so a caller
 * never has to do that multiplication. Returns `undefined`, rather than a `NaN` total,
 * when either string is missing or the wrong type (issue #93). `valueFractionalUnit` may
 * legitimately be `""` (rounds to "00" cents below); `valueMainUnit` may not, since an
 * empty whole-unit string has no honest reading. */
function toMoney(price: RyanairPrice): Money | undefined {
	if (
		!isRecord(price) ||
		!isNonEmptyString(price.valueMainUnit) ||
		typeof price.valueFractionalUnit !== 'string' ||
		!isNonEmptyString(price.currencyCode)
	) {
		return undefined;
	}
	const wholeUnits = Number.parseInt(price.valueMainUnit, 10);
	const fractionalUnits = Number.parseInt(price.valueFractionalUnit.padEnd(2, '0').slice(0, 2), 10);
	if (!Number.isFinite(wholeUnits) || !Number.isFinite(fractionalUnits)) return undefined;
	return { minorUnits: wholeUnits * 100 + fractionalUnits, currency: price.currencyCode };
}

/** Ryanair does not publish a documented deep-link format for a specific fare; this
 * mirrors the query parameters its own site's flight-selection page reads (verified by
 * hand 2026-09-04: it 302-redirects into a live search pre-filled with these dates and
 * airports). Best-effort rather than contractual — re-check if Ryanair changes its
 * booking flow. */
function deepLinkFor(fare: RyanairFare): string {
	const { departureAirport, arrivalAirport, departureDate } = fare.outbound;
	const dateOut = departureDate.slice(0, 10);
	const params = new URLSearchParams({
		adults: '1',
		teens: '0',
		children: '0',
		infants: '0',
		dateOut,
		dateIn: '',
		isConnectedFlight: 'false',
		discount: '0',
		isReturn: 'false',
		promoCode: '',
		originIata: departureAirport.iataCode,
		destinationIata: arrivalAirport.iataCode
	});
	return `https://www.ryanair.com/gb/en/trip/flights/select?${params.toString()}`;
}

/**
 * Maps one raw fare to a domain `FlightOffer`, or `undefined` when the fare is missing or
 * has the wrong type for any field this function reads — either a structural surprise
 * (the fare finder's `fares` array holding something that isn't a well-formed fare at
 * all) or the honest "no known timezone" case documented below. Either way, the caller
 * (`mapFaresToFlightOffers`) drops this one fare instead of failing the whole batch over
 * it, per AGENTS.md "say what you do not know rather than guessing" and issue #93.
 *
 * The zone check specifically: `undefined` instead of a best-guess offset when either
 * airport's IANA zone is missing from `timeZoneByIataCode` — that can only happen when
 * Ryanair's own route/airport feeds disagree about an airport code, and a wrong offset is
 * worse than one missing offer.
 */
export function mapFareToFlightOffer(
	fare: RyanairFare,
	timeZoneByIataCode: Readonly<Record<string, string>>
): FlightOffer | undefined {
	if (!isRecord(fare) || !isRecord(fare.outbound)) return undefined;
	const outbound = fare.outbound;

	if (!isRecord(outbound.departureAirport) || !isRecord(outbound.arrivalAirport)) return undefined;
	const departureIataCode = outbound.departureAirport.iataCode;
	const arrivalIataCode = outbound.arrivalAirport.iataCode;
	if (!isNonEmptyString(departureIataCode) || !isNonEmptyString(arrivalIataCode)) return undefined;

	const departureTimeZone = timeZoneByIataCode[departureIataCode];
	const arrivalTimeZone = timeZoneByIataCode[arrivalIataCode];
	if (!departureTimeZone || !arrivalTimeZone) return undefined;

	// The cross-check (crosscheck.ts) matches offers across providers on flight number —
	// a missing one here would not throw, it would silently break that match.
	if (!isNonEmptyString(outbound.flightNumber)) return undefined;

	if (!isParsableLocalIsoString(outbound.departureDate) || !isParsableLocalIsoString(outbound.arrivalDate)) {
		return undefined;
	}

	const price = toMoney(outbound.price);
	if (!price) return undefined;

	const departure = toLocalDateTime(outbound.departureDate, departureTimeZone);
	const arrival = toLocalDateTime(outbound.arrivalDate, arrivalTimeZone);

	return {
		carrier: RYANAIR_CARRIER,
		flightNumber: outbound.flightNumber,
		departureAirport: departureIataCode,
		arrivalAirport: arrivalIataCode,
		departure,
		arrival,
		duration: computeFlightDuration(departure, arrival),
		price,
		fareBrand: 'Basic',
		baggage: BASIC_FARE_BAGGAGE,
		deepLink: deepLinkFor(fare)
	};
}

/** Maps every fare in a fare-finder response, silently skipping any one fare
 * `mapFareToFlightOffer` can't honestly map — an unknown airport timezone, a malformed or
 * mistyped field, or a structurally broken entry — instead of throwing over one bad
 * entry. */
export function mapFaresToFlightOffers(
	response: RyanairOneWayFaresResponse,
	timeZoneByIataCode: Readonly<Record<string, string>>
): FlightOffer[] {
	const offers: FlightOffer[] = [];
	for (const fare of response.fares) {
		const offer = mapFareToFlightOffer(fare, timeZoneByIataCode);
		if (offer) offers.push(offer);
	}
	return offers;
}

/** IATA codes of every airport reachable directly from the origin the routes response was
 * fetched for. De-duplicated because the raw feed can list the same destination more than
 * once (e.g. a seasonal-route entry alongside the year-round one) — issue #12's connection
 * graph wants a set of candidate airports, not a count of how many route entries mention
 * each one. */
export function mapRoutesToDestinations(routes: RyanairRoutesResponse): IataAirportCode[] {
	const codes = new Set<string>();
	for (const route of routes) {
		if (route.arrivalAirport?.code) codes.add(route.arrivalAirport.code);
	}
	return Array.from(codes);
}

/** Projects Ryanair's ~220-airport active-airports response down to just what this
 * adapter actually needs — IATA code to IANA timezone — before it goes anywhere near the
 * cache. The raw response carries route lists, categories and priority scores this
 * adapter has no use for; caching only the projection keeps the cached entry a few
 * kilobytes instead of a few hundred. */
export function buildTimeZoneIndex(
	airports: readonly { iataCode: string; timeZone: string }[]
): Record<string, string> {
	const index: Record<string, string> = {};
	for (const airport of airports) {
		if (airport.iataCode && airport.timeZone) index[airport.iataCode] = airport.timeZone;
	}
	return index;
}
