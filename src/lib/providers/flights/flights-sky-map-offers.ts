import type { Duration, FlightOffer, IsoCurrencyCode } from '../../domain';
import { buildSearchResultsDeepLink } from './flights-sky-deep-link';
import { parseItineraryPrice } from './flights-sky-money';
import { toLocalDateTime } from './airport-timezone';

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
	/** Every airport code this response's offers can reference, pre-resolved once per
	 * `searchOffers` call (see flights-sky.ts) — the same "resolve zones once, up front"
	 * shape skyscanner-map-offers.ts already uses, now both sharing airport-timezone.ts. */
	timeZones: ReadonlyMap<string, string>;
}

/**
 * `mapSearchOneWayToOffers`'s return: the offers this response actually supports, plus which
 * otherwise-real, otherwise-mappable itineraries got dropped for lack of a known time zone —
 * issue #124's BVC finding. Boa Vista's real, nonstop, bookable TUI flight to London Gatwick
 * came back in the raw response and was silently discarded because BVC was not in the old
 * hand-curated table; the page then said "no route" about a route the provider had just
 * priced. Surfacing which airport blocked it, distinctly from "this response never had a
 * usable fare at all", is what lets flights-sky.ts record something a results screen can
 * show honestly instead of a bare, indistinguishable empty list.
 */
export interface MapSearchOneWayResult {
	offers: FlightOffer[];
	/** IATA codes of airports that were the one thing standing between a real itinerary in
	 * this response and a mapped `FlightOffer` — right shape, right stop count, every other
	 * field present, only the time zone unresolved. Empty when nothing in the response was
	 * that close (every itinerary had a stop, a malformed field, or there simply were none). */
	unresolvedTimeZoneAirports: ReadonlySet<string>;
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
 *   for field (see flights-sky-types.ts's header comment). Confirmed live for issue #124's
 *   BVC -> LGW case: 9 real itineraries, 1 genuinely nonstop (TUI, stopCount 0) and rightly
 *   kept, the rest correctly rejected here — this filter was never the problem.
 * - An itinerary whose airport is missing a resolvable time zone (`options.timeZones`), or
 *   whose price does not parse. AGENTS.md: say what you do not know rather than guessing.
 */
export function mapSearchOneWayToOffers(raw: unknown, options: MapSearchOneWayOptions): MapSearchOneWayResult {
	const itineraries = extractItineraries(raw);
	const offers: FlightOffer[] = [];
	const unresolvedTimeZoneAirports = new Set<string>();
	for (const itinerary of itineraries) {
		const result = mapDirectItinerary(itinerary, options);
		if (result.offer !== undefined) offers.push(result.offer);
		for (const code of result.unresolvedTimeZoneAirports) unresolvedTimeZoneAirports.add(code);
	}
	return { offers, unresolvedTimeZoneAirports };
}

function extractItineraries(raw: unknown): unknown[] {
	if (isRecord(raw) && isRecord(raw.data) && Array.isArray(raw.data.itineraries)) {
		return raw.data.itineraries;
	}
	throw new FlightsSkyMalformedOfferResponseError(
		'Flights Sky search-one-way response did not have a data.itineraries array'
	);
}

interface DirectItineraryResult {
	offer?: FlightOffer;
	/** Populated only when this itinerary was otherwise fully mappable (right shape, right
	 * stop count, every other field present) and the ONLY reason it was dropped is a missing
	 * time zone for the origin and/or destination — never for an itinerary rejected for some
	 * other, ordinary reason, so a caller counting these never confuses "ordinary stopover
	 * fare" with "we found a real nonstop fare we could not price." */
	unresolvedTimeZoneAirports: string[];
}

function mapDirectItinerary(itinerary: unknown, options: MapSearchOneWayOptions): DirectItineraryResult {
	const none: DirectItineraryResult = { unresolvedTimeZoneAirports: [] };
	if (!isRecord(itinerary)) return none;

	// One-way query, so a mappable itinerary has exactly one leg.
	const legs = itinerary.legs;
	if (!Array.isArray(legs) || legs.length !== 1) return none;
	const leg = legs[0];
	if (!isRecord(leg)) return none;
	if (leg.stopCount !== 0) return none; // see file header: connections are the itinerary builder's job

	const segments = leg.segments;
	if (!Array.isArray(segments) || segments.length !== 1) return none;
	const segment = segments[0];
	if (!isRecord(segment)) return none;

	const originCode = asString(isRecord(leg.origin) ? leg.origin.id : undefined);
	const destinationCode = asString(isRecord(leg.destination) ? leg.destination.id : undefined);
	if (originCode === undefined || destinationCode === undefined) return none;

	const departureLocal = asString(segment.departure) ?? asString(leg.departure);
	const arrivalLocal = asString(segment.arrival) ?? asString(leg.arrival);
	if (departureLocal === undefined || arrivalLocal === undefined) return none;

	const marketingCarrier = segment.marketingCarrier;
	// The marketing carrier, not the operating one: the traveller books, pays and receives a
	// ticket under the marketing carrier's name, same reasoning as skyscanner-map-offers.ts.
	const carrierCode = asString(isRecord(marketingCarrier) ? marketingCarrier.displayCode : undefined);
	const carrierName = asString(isRecord(marketingCarrier) ? marketingCarrier.name : undefined);
	const flightNumberSuffix = asString(segment.flightNumber);
	if (carrierCode === undefined || carrierName === undefined || flightNumberSuffix === undefined) {
		return none;
	}

	const price = parseItineraryPrice(isRecord(itinerary.price) ? itinerary.price : undefined, options.currency);
	if (price === undefined) return none;

	const durationMinutes = asNumber(leg.durationInMinutes) ?? asNumber(segment.durationInMinutes);
	if (durationMinutes === undefined) return none;

	// Every other field checks out — this itinerary is real and otherwise bookable. The time
	// zone is the last gate, and the only one worth telling a caller about when it fails: see
	// MapSearchOneWayResult's own doc comment.
	const departure = toLocalDateTime(departureLocal, originCode, options.timeZones);
	const arrival = toLocalDateTime(arrivalLocal, destinationCode, options.timeZones);
	if (departure === undefined || arrival === undefined) {
		const unresolved: string[] = [];
		if (departure === undefined) unresolved.push(originCode);
		if (arrival === undefined) unresolved.push(destinationCode);
		return { unresolvedTimeZoneAirports: unresolved };
	}

	return {
		unresolvedTimeZoneAirports: [],
		offer: {
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
		}
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
