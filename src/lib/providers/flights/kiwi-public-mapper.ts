/**
 * Pure translation from Kiwi's public GraphQL shapes (kiwi-public-types.ts) to this app's
 * domain shapes. No I/O, no cache, no fetch, so kiwi-public-mapper.test.ts runs entirely
 * off the captured fixtures.
 *
 * Every function here re-checks the values it reads instead of trusting the interfaces in
 * kiwi-public-types.ts, which describe one set of real responses rather than a contract
 * Kiwi has promised to keep. One malformed itinerary is dropped; it never takes the rest of
 * the batch down with it (AGENTS.md: "say what you do not know rather than guessing").
 */

import type {
	BaggageAllowance,
	Carrier,
	Duration,
	FlightOffer,
	IataAirportCode,
	IsoCalendarDate
} from '../../domain';
import { moneyFromDecimalString } from '../../domain';
// buildLocalDateTime is the codebase's existing wall-clock-plus-IANA-zone-to-offset
// conversion (the two-pass DST-aware technique documented in that file). It lives under a
// Skyscanner-prefixed name for historical reasons but is a pure, provider-agnostic helper,
// and re-implementing the same arithmetic here would be a second place to get a DST
// boundary wrong.
import { buildLocalDateTime } from './airport-timezone';
import type {
	KiwiPublicItinerary,
	KiwiPublicItinerariesResult,
	KiwiPublicOnePerCityResult,
	KiwiPublicSegment
} from './kiwi-public-types';

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * The runtime "this really is an object, not null and not a surprise scalar" check, without
 * throwing away what the declared type says the object contains — narrowing to
 * `Record<string, unknown>` instead would leave every field below typed `unknown` and force
 * a cast at each one, which is how a re-validation layer stops being readable.
 *
 * Guards against a shape kiwi-public-types.ts cannot express: those interfaces describe one
 * captured response, and an undocumented endpoint is free to send `null` where it once sent
 * an object.
 */
function isObjectLike<T>(value: T | null | undefined): value is T {
	return typeof value === 'object' && value !== null;
}

/** True when `value` parses as a wall-clock ISO string. Checked before `buildLocalDateTime`
 * rather than after, because that function's internal `Date` arithmetic silently produces
 * `NaN` offsets for an unparsable string instead of throwing, and a `NaN` offset is a wrong
 * itinerary rather than a dropped one. */
function isParsableLocalIsoString(value: unknown): value is string {
	return isNonEmptyString(value) && !Number.isNaN(Date.parse(`${value}Z`));
}

/**
 * Kiwi reports segment length in SECONDS (measured: BVC→LGW came back as 21000, matching
 * the 5h50m between its own two local times), while domain `Duration` is minutes. Rounded
 * rather than truncated so a schedule stored with an odd number of seconds does not lose a
 * minute; rejected outright when it is not a positive finite number, since a zero-minute
 * flight is not a thing this app should ever display.
 */
export function parseKiwiDurationMinutes(seconds: unknown): Duration | undefined {
	if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
	return Math.round(seconds / 60) as Duration;
}

/**
 * Kiwi's `bagsInfo` carries real per-fare counts, unlike Ryanair's fare finder which says
 * nothing and forces its own mapper to hardcode the Basic allowance. Absent or non-numeric
 * counts fall back to zero rather than dropping the offer: "we do not know how many bags
 * are included" is a much smaller problem than losing a real, bookable flight, and a
 * baggage-aware scorer reading `0` is no worse off than one reading nothing.
 */
function parseBaggage(bagsInfo: unknown): BaggageAllowance {
	const record = isRecord(bagsInfo) ? bagsInfo : {};
	const checked = record.includedCheckedBags;
	const hand = record.includedHandBags;
	return {
		cabinBagsIncluded: typeof hand === 'number' && Number.isFinite(hand) && hand >= 0 ? hand : 0,
		checkedBagsIncluded:
			typeof checked === 'number' && Number.isFinite(checked) && checked >= 0 ? checked : 0
	};
}

/**
 * Kiwi has no documented per-fare deep link, and the base64 itinerary id its search returns
 * is not accepted by any URL this project could verify. This builds the pre-filled search
 * page instead — `https://www.kiwi.com/en/search/results/BVC/LGW/2026-10-06`, confirmed by
 * hand on 2026-09-04 to return HTTP 200 with IATA codes in the path. Best-effort and
 * explicitly not a link to this exact fare, the same honesty ryanair-mapper.ts's own
 * `deepLinkFor` settles for.
 */
export function buildKiwiDeepLink(
	origin: string,
	destination: string,
	departureDate: IsoCalendarDate
): string {
	return `https://www.kiwi.com/en/search/results/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}/${encodeURIComponent(departureDate)}`;
}

/** The one segment of a direct itinerary, or `undefined` when the itinerary has any other
 * number of them. A `FlightOffer` is one flight; an itinerary Kiwi returned with two legs
 * despite `maxStopsCount: 0` is not one, and flattening it would invent a flight nobody
 * sells — the highest-severity bug this repo names (docs/ACCEPTANCE.md, "Never ship a
 * flight that does not exist"). */
function soleSegmentOf(itinerary: KiwiPublicItinerary): KiwiPublicSegment | undefined {
	const segments = itinerary?.sector?.sectorSegments;
	if (!Array.isArray(segments) || segments.length !== 1) return undefined;
	const segment = segments[0]?.segment;
	return isObjectLike(segment) ? segment : undefined;
}

/**
 * Maps one direct itinerary to a `FlightOffer`, or `undefined` when any field this needs is
 * missing, mistyped, or dishonest to guess at. Deliberately strict about the four things a
 * wrong value would corrupt silently rather than visibly: the price, the two timezones, the
 * flight number (which crosscheck.ts matches offers across providers on) and the segment
 * count.
 */
export function mapItineraryToFlightOffer(itinerary: KiwiPublicItinerary): FlightOffer | undefined {
	if (!isObjectLike(itinerary)) return undefined;

	const segment = soleSegmentOf(itinerary);
	if (!segment) return undefined;

	const source = segment.source;
	const destination = segment.destination;
	if (!isObjectLike(source) || !isObjectLike(destination)) return undefined;

	const departureAirport = source.station?.code;
	const arrivalAirport = destination.station?.code;
	if (!isNonEmptyString(departureAirport) || !isNonEmptyString(arrivalAirport)) return undefined;

	// Kiwi hands over the IANA zone per station, which is the whole reason this adapter
	// needs no Transitous round trip. A missing one is still fatal to the offer: AGENTS.md
	// is explicit that a wrong offset is how an overnight connection loses a night.
	const departureTimeZone = source.station?.timezone;
	const arrivalTimeZone = destination.station?.timezone;
	if (!isNonEmptyString(departureTimeZone) || !isNonEmptyString(arrivalTimeZone)) return undefined;

	if (!isParsableLocalIsoString(source.localTime) || !isParsableLocalIsoString(destination.localTime)) {
		return undefined;
	}

	const carrierCode = segment.carrier?.code;
	const carrierName = segment.carrier?.name;
	if (!isNonEmptyString(carrierCode)) return undefined;

	// Kiwi splits the flight number: `carrier.code` is "BY" and `segment.code` is "259".
	// Joined here into the "BY259" form every other adapter in this codebase produces, so
	// crosscheck.ts can match the same flight across providers.
	if (!isNonEmptyString(segment.code)) return undefined;
	const flightNumber = `${carrierCode}${segment.code}`;

	// Kiwi prices as a decimal string ("173", "173.50"), read digit-wise so nothing goes
	// through a float, and split into minor units by the currency's own exponent rather
	// than a hardcoded two decimal places (issue #179).
	const price = moneyFromDecimalString(itinerary.price?.amount, itinerary.price?.currency?.code);
	if (!price) return undefined;

	const duration = parseKiwiDurationMinutes(segment.duration);
	if (duration === undefined) return undefined;

	const carrier: Carrier = {
		iataCode: carrierCode,
		name: isNonEmptyString(carrierName) ? carrierName : carrierCode
	};

	return {
		carrier,
		flightNumber,
		departureAirport,
		arrivalAirport,
		departure: buildLocalDateTime(source.localTime, departureTimeZone),
		arrival: buildLocalDateTime(destination.localTime, arrivalTimeZone),
		duration,
		price,
		// Always one adult's fare, by construction — kiwi-public-queries.ts sends
		// `adults: 1` regardless of the real party size precisely so this is a fact rather
		// than an assumption (issue #109).
		priceScope: 'per-person',
		baggage: parseBaggage(itinerary.bagsInfo),
		deepLink: buildKiwiDeepLink(departureAirport, arrivalAirport, source.localTime.slice(0, 10))
	};
}

/** Kiwi's `AppError` message when the query resolved to one, or `undefined` on success.
 * Read so kiwi-public.ts can surface Kiwi's own wording rather than inventing a cause. */
export function appErrorOf(result: unknown): string | undefined {
	if (!isRecord(result)) return undefined;
	return isNonEmptyString(result.error) ? result.error : undefined;
}

/** Maps every itinerary in a one-way response, skipping any single one that cannot be
 * mapped honestly. */
export function mapOneWayResultToOffers(result: KiwiPublicItinerariesResult | undefined): FlightOffer[] {
	const itineraries = result?.itineraries;
	if (!Array.isArray(itineraries)) return [];

	const offers: FlightOffer[] = [];
	for (const itinerary of itineraries) {
		const offer = mapItineraryToFlightOffer(itinerary);
		if (offer) offers.push(offer);
	}
	return offers;
}

/**
 * IATA codes of every airport reachable directly from the origin the one-per-city response
 * was fetched for, de-duplicated and airports only.
 *
 * The `type === 'AIRPORT'` filter is the important line. Kiwi can answer with bus and train
 * stations (its `transportTypes` filter narrows the itineraries, not the station vocabulary)
 * and with metropolitan-area codes, and issue #89 already found what happens downstream when
 * a non-airport code reaches the connection graph: every airport-level provider rejects it,
 * and each rejection costs a real request before anything notices.
 */
export function mapOnePerCityResultToDestinations(
	result: KiwiPublicOnePerCityResult | undefined
): IataAirportCode[] {
	const itineraries = result?.itineraries;
	if (!Array.isArray(itineraries)) return [];

	const codes = new Set<string>();
	for (const itinerary of itineraries) {
		const station = itinerary?.destination?.station;
		if (!isRecord(station)) continue;
		if (station.type !== 'AIRPORT') continue;
		if (isNonEmptyString(station.code)) codes.add(station.code.toUpperCase());
	}
	return Array.from(codes);
}
