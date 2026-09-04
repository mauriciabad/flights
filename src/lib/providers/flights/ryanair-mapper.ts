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

/** Converts Ryanair's price to `Money`'s integer minor units using the two pre-split
 * decimal strings rather than `value` itself — `14.99 * 100` is not reliably `1499` in
 * floating point, and `valueMainUnit`/`valueFractionalUnit` exist precisely so a caller
 * never has to do that multiplication. */
function toMoney(price: RyanairPrice): Money {
	const wholeUnits = Number.parseInt(price.valueMainUnit, 10);
	const fractionalDigits = price.valueFractionalUnit.padEnd(2, '0').slice(0, 2);
	return { minorUnits: wholeUnits * 100 + Number.parseInt(fractionalDigits, 10), currency: price.currencyCode };
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
 * Maps one raw fare to a domain `FlightOffer`. Returns `undefined` instead of a
 * best-guess offset when either airport's IANA zone is missing from
 * `timeZoneByIataCode` — that can only happen when Ryanair's own route/airport feeds
 * disagree about an airport code, and a wrong offset is worse than one missing offer, per
 * AGENTS.md "say what you do not know rather than guessing." The caller
 * (`mapFaresToFlightOffers`) drops this one fare instead of failing the whole batch over
 * it.
 */
export function mapFareToFlightOffer(
	fare: RyanairFare,
	timeZoneByIataCode: Readonly<Record<string, string>>
): FlightOffer | undefined {
	const { outbound } = fare;
	const departureTimeZone = timeZoneByIataCode[outbound.departureAirport.iataCode];
	const arrivalTimeZone = timeZoneByIataCode[outbound.arrivalAirport.iataCode];
	if (!departureTimeZone || !arrivalTimeZone) return undefined;

	const departure = toLocalDateTime(outbound.departureDate, departureTimeZone);
	const arrival = toLocalDateTime(outbound.arrivalDate, arrivalTimeZone);

	return {
		carrier: RYANAIR_CARRIER,
		flightNumber: outbound.flightNumber,
		departureAirport: outbound.departureAirport.iataCode,
		arrivalAirport: outbound.arrivalAirport.iataCode,
		departure,
		arrival,
		duration: computeFlightDuration(departure, arrival),
		price: toMoney(outbound.price),
		fareBrand: 'Basic',
		baggage: BASIC_FARE_BAGGAGE,
		deepLink: deepLinkFor(fare)
	};
}

/** Maps every fare in a fare-finder response, silently skipping any whose airports have no
 * known timezone (see `mapFareToFlightOffer`) instead of throwing over one bad entry. */
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
