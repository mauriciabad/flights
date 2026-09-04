import type { Duration, FlightOffer, IsoCurrencyCode } from '../../domain';
import { buildSearchResultsDeepLink } from './flights-sky-deep-link';
import { parseItineraryPrice } from './flights-sky-money';
import { toLocalDateTime } from './flights-sky-timezone';

/** Thrown when `search-one-way`'s response is not merely missing a mappable itinerary (see
 * `mapDirectItinerary`) but does not have the shape this adapter was built against at all —
 * no `data.itineraries` array. The caller (flights-sky.ts) treats this as a
 * `malformed-response` for that one call rather than letting it propagate uncaught, per
 * `types.ts`'s "adapters never throw" rule; a pure mapping function is not itself an adapter
 * method and is free to throw internally. */
export class FlightsSkyMalformedOfferResponseError extends Error {}

export interface MapSearchOneWayOptions {
	currency: IsoCurrencyCode;
	travellers: number;
}

/**
 * Turns one `search-one-way` response into `FlightOffer[]`, keeping only itineraries this
 * adapter can map honestly. Two kinds get dropped, both on purpose:
 *
 * - Anything with a layover (`stopCount > 0`). `FlightOffer` (../../domain/flight-offer.ts)
 *   models one operated flight, not a connection this provider already bundled at its own
 *   price — this app builds its own connections from direct legs, so a provider-chosen
 *   stopover the itinerary builder never gets to evaluate would be a second, competing
 *   connection logic living inside this one adapter. Same reasoning as
 *   skyscanner-map-offers.ts, which this adapter's response shape otherwise mirrors field
 *   for field (see flights-sky-types.ts's header comment).
 * - An itinerary whose airport is missing from flights-sky-timezone.ts's curated table, or
 *   whose price does not parse. AGENTS.md: say what you do not know rather than guessing.
 */
export function mapSearchOneWayToOffers(raw: unknown, options: MapSearchOneWayOptions): FlightOffer[] {
	const itineraries = extractItineraries(raw);
	const offers: FlightOffer[] = [];
	for (const itinerary of itineraries) {
		const offer = mapDirectItinerary(itinerary, options);
		if (offer !== undefined) offers.push(offer);
	}
	return offers;
}

function extractItineraries(raw: unknown): unknown[] {
	if (isRecord(raw) && isRecord(raw.data) && Array.isArray(raw.data.itineraries)) {
		return raw.data.itineraries;
	}
	throw new FlightsSkyMalformedOfferResponseError(
		'Flights Sky search-one-way response did not have a data.itineraries array'
	);
}

function mapDirectItinerary(itinerary: unknown, options: MapSearchOneWayOptions): FlightOffer | undefined {
	if (!isRecord(itinerary)) return undefined;

	// One-way query, so a mappable itinerary has exactly one leg.
	const legs = itinerary.legs;
	if (!Array.isArray(legs) || legs.length !== 1) return undefined;
	const leg = legs[0];
	if (!isRecord(leg)) return undefined;
	if (leg.stopCount !== 0) return undefined; // see file header: connections are the itinerary builder's job

	const segments = leg.segments;
	if (!Array.isArray(segments) || segments.length !== 1) return undefined;
	const segment = segments[0];
	if (!isRecord(segment)) return undefined;

	const originCode = asString(isRecord(leg.origin) ? leg.origin.id : undefined);
	const destinationCode = asString(isRecord(leg.destination) ? leg.destination.id : undefined);
	if (originCode === undefined || destinationCode === undefined) return undefined;

	const departureLocal = asString(segment.departure) ?? asString(leg.departure);
	const arrivalLocal = asString(segment.arrival) ?? asString(leg.arrival);
	if (departureLocal === undefined || arrivalLocal === undefined) return undefined;

	const departure = toLocalDateTime(departureLocal, originCode);
	const arrival = toLocalDateTime(arrivalLocal, destinationCode);
	if (departure === undefined || arrival === undefined) return undefined;

	const marketingCarrier = segment.marketingCarrier;
	// The marketing carrier, not the operating one: the traveller books, pays and receives a
	// ticket under the marketing carrier's name, same reasoning as skyscanner-map-offers.ts.
	const carrierCode = asString(isRecord(marketingCarrier) ? marketingCarrier.displayCode : undefined);
	const carrierName = asString(isRecord(marketingCarrier) ? marketingCarrier.name : undefined);
	const flightNumberSuffix = asString(segment.flightNumber);
	if (carrierCode === undefined || carrierName === undefined || flightNumberSuffix === undefined) {
		return undefined;
	}

	const price = parseItineraryPrice(isRecord(itinerary.price) ? itinerary.price : undefined, options.currency);
	if (price === undefined) return undefined;

	const durationMinutes = asNumber(leg.durationInMinutes) ?? asNumber(segment.durationInMinutes);
	if (durationMinutes === undefined) return undefined;

	return {
		carrier: { iataCode: carrierCode, name: carrierName },
		flightNumber: `${carrierCode}${flightNumberSuffix}`,
		departureAirport: originCode,
		arrivalAirport: destinationCode,
		departure,
		arrival,
		duration: durationMinutes as Duration,
		price,
		// Issue #109: `search-one-way`'s own request shape (`SearchOneWayParams`,
		// flights-sky-client.ts) has no adults/travellers field at all — this adapter never
		// tells the API how many travellers to price for, so whatever comes back is
		// definitionally one adult's fare, confirmed by construction rather than a live
		// measurement (there is no "ask for N adults" channel to have measured against).
		priceScope: 'per-person',
		// `fareAttributes` is always `{}` in the captured fixture, so this API never returns
		// baggage allowance for a search-one-way result. `baggage` is not optional on
		// `FlightOffer`, so 0 here means "not returned by this provider," not "confirmed zero
		// bags" — a caller rendering this field should treat it as unverified.
		baggage: { cabinBagsIncluded: 0, checkedBagsIncluded: 0 },
		deepLink: buildSearchResultsDeepLink({
			origin: originCode,
			destination: destinationCode,
			departureDate: departureLocal.slice(0, 10),
			travellers: options.travellers,
			currency: options.currency
		})
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
