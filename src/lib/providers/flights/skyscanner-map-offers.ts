import type { Duration, FlightOffer, IsoCurrencyCode } from '../../domain';
import { buildSearchResultsDeepLink } from './skyscanner-deep-link';
import { parseOfferPrice } from './skyscanner-money';
import { toLocalDateTime } from './airport-timezone';

/** Thrown when `searchFlights`'s response is not merely missing a mappable itinerary (that
 * is normal, see `mapDirectItinerary`) but does not have the shape this adapter was built
 * against at all: no `data.itineraries` array. The caller (skyscanner.ts) catches this and
 * turns it into a `malformed-response` ProviderError, since a pure mapping function is not
 * itself an adapter method and is free to throw. */
export class SkyscannerMalformedResponseError extends Error {}

export interface MapSearchFlightsOptions {
	currency: IsoCurrencyCode;
	travellers: number;
	/** IATA code -> resolved IANA zone, for every airport this response's itineraries can
	 * reference. Resolved once per `searchOffers` call (skyscanner.ts), not per itinerary or
	 * per date: a one-way `searchFlights` response only ever contains itineraries for the
	 * queried origin and destination, so their zones never change across the date range a
	 * search loops over. A code missing from this map means neither the seed table nor a
	 * live Transitous lookup could resolve it (airport-timezone.ts `resolveAirportTimeZone`)
	 * — every itinerary touching that airport gets dropped below, never mistimed. */
	timeZones: ReadonlyMap<string, string>;
}

/**
 * Turns one `searchFlights` response into `FlightOffer[]`, keeping only itineraries this
 * adapter can map honestly and dropping the rest.
 *
 * Two kinds of itinerary get dropped, both on purpose, not as a bug:
 *
 * - Anything with a layover (`stopCount > 0`). The domain's `FlightOffer` (flight-offer.ts)
 *   models one operated flight (one carrier, one flight number, one aircraft), not a
 *   connection Skyscanner already bundled at its own price. This app builds its own
 *   connections from direct legs (docs/prompts/001-initial-brief.md: "Get all flights from
 *   Origin to Every Connection... Get all flights from Every Connection to Destination"),
 *   so a Skyscanner-chosen stopover the itinerary builder never gets to evaluate would be a
 *   second, competing connection logic living inside this one adapter.
 * - An itinerary whose airport's time zone could not be resolved (`options.timeZones` has no
 *   entry for it — see MapSearchFlightsOptions), or whose price parses to nothing usable.
 *   AGENTS.md: say what you do not know rather than guessing.
 */
export function mapSearchFlightsToOffers(raw: unknown, options: MapSearchFlightsOptions): FlightOffer[] {
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
	throw new SkyscannerMalformedResponseError(
		'Sky Scrapper searchFlights response did not have a data.itineraries array'
	);
}

function mapDirectItinerary(itinerary: unknown, options: MapSearchFlightsOptions): FlightOffer | undefined {
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

	const departure = toLocalDateTime(departureLocal, originCode, options.timeZones);
	const arrival = toLocalDateTime(arrivalLocal, destinationCode, options.timeZones);
	if (departure === undefined || arrival === undefined) return undefined;

	const marketingCarrier = segment.marketingCarrier;
	// The marketing carrier, not the operating one: the fixture's Ryanair/Lauda Europe pair
	// (marketingCarrier "FR", operatingCarrier "LW") is a real wet-lease case, and the
	// traveller books, pays and receives a ticket under the marketing carrier's name.
	const carrierCode = asString(isRecord(marketingCarrier) ? marketingCarrier.displayCode : undefined);
	const carrierName = asString(isRecord(marketingCarrier) ? marketingCarrier.name : undefined);
	const flightNumberSuffix = asString(segment.flightNumber);
	if (carrierCode === undefined || carrierName === undefined || flightNumberSuffix === undefined) {
		return undefined;
	}

	const price = parseOfferPrice(isRecord(itinerary.price) ? itinerary.price : undefined, options.currency);
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
		// duration.ts: "produce one with `123 as Duration` at the point a literal is known."
		// This minute count came straight off the wire, so this is that point.
		duration: durationMinutes as Duration,
		price,
		// Issue #109: measured live 2026-09-04, same route/date, only `adults` changed —
		// 1 adult priced at 336.51/588.97, 3 adults at 966.21/1766.38. 588.97 * 3 = 1766.91,
		// not 1766.38: Sky Scrapper already returns the whole party's total for the
		// `adults` count this adapter requests (skyscanner.ts's own `adults: String(travellers)`),
		// never a per-adult figure to multiply again.
		priceScope: 'party-total',
		// Sky Scrapper's search endpoint never returns baggage allowance at all (confirmed
		// against the real captured fixture: `fareAttributes` is always `{}`). Getting it
		// needs a per-itinerary details call this adapter's 20-requests-a-month budget
		// cannot spend on every offer shown. `baggage` is not optional on FlightOffer, so 0
		// is written here as "not returned by this provider," not as "confirmed zero bags,"
		// and callers rendering this field should treat a Sky Scrapper offer's baggage
		// count as unverified rather than as a guarantee.
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
