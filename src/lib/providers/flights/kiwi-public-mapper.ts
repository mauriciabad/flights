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
	IsoCalendarDate,
	TechnicalStop
} from '../../domain';
import { moneyFromDecimalString } from '../../domain';
// buildLocalDateTime is the codebase's existing wall-clock-plus-IANA-zone-to-offset
// conversion (the two-pass DST-aware technique documented in that file). It lives under a
// Skyscanner-prefixed name for historical reasons but is a pure, provider-agnostic helper,
// and re-implementing the same arithmetic here would be a second place to get a DST
// boundary wrong.
import { buildLocalDateTime, elapsedMinutes } from './airport-timezone';
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

/**
 * True when the passenger stays on the aircraft between `before` and `after` — i.e. the two
 * are the same flight and the airport between them is a technical stop, not a connection.
 * Issue #210.
 *
 * Both available signals must agree, and that is deliberately stricter than either alone:
 *
 * - **Kiwi's own `followingTechnicalStop`** is the primary signal, and it is a real field on
 *   `Segment` rather than an inference (introspected 2026-09-04; `kiwi-public-types.ts`
 *   records how its direction was established from a live response). When it is present and
 *   `false`, that is Kiwi saying "you change planes here", and this returns false even if
 *   the flight numbers match — an airline can sell one flight NUMBER across a change of
 *   aircraft, which IATA calls a direct flight and a traveller calls carrying their bag to
 *   another gate.
 * - **The same-carrier-same-number rule** is what "one flight" means, and it is the fallback
 *   for when the field is absent, since an undocumented endpoint is free to drop it. It also
 *   guards the other direction: without it, a `true` across two different flight numbers
 *   would let one offer print a flight number that covers only half of itself.
 *
 * Absence is never read as `true`. A stop this cannot positively confirm is treated as a
 * plane change, which loses a route at worst; the opposite error offers a traveller a city
 * they cannot legally enter, which docs/ACCEPTANCE.md ranks above every feature.
 */
function isTechnicalStopBetween(before: KiwiPublicSegment, after: KiwiPublicSegment): boolean {
	// The stop physically has to be one place: whatever the flags say, an itinerary that
	// lands at one airport and departs from another is a transfer somebody has to make.
	const arrivalAirport = before.destination?.station?.code;
	const departureAirport = after.source?.station?.code;
	if (!isNonEmptyString(arrivalAirport) || arrivalAirport !== departureAirport) return false;

	const sameFlight =
		isNonEmptyString(before.code) &&
		before.code === after.code &&
		isNonEmptyString(before.carrier?.code) &&
		before.carrier?.code === after.carrier?.code;
	if (!sameFlight) return false;

	return typeof before.followingTechnicalStop === 'boolean' ? before.followingTechnicalStop : true;
}

/**
 * The segments of an itinerary that is ONE flight the traveller boards once — a single
 * segment, or several joined only by technical stops — or `undefined` for anything else.
 *
 * The `undefined` branch is the one that matters. Kiwi is now asked for itineraries with up
 * to one stop (`kiwi-public-queries.ts` explains why), so genuine two-flight connections do
 * arrive here and every one of them must be refused: this app builds its own connections so
 * it can put a night in the middle, and collapsing somebody else's would either invent a
 * flight nobody sells or reprice two legs as one — the highest-severity bug this repo names
 * (docs/ACCEPTANCE.md, "Never ship a flight that does not exist").
 */
function singleFlightSegmentsOf(itinerary: KiwiPublicItinerary): KiwiPublicSegment[] | undefined {
	const sectorSegments = itinerary?.sector?.sectorSegments;
	if (!Array.isArray(sectorSegments) || sectorSegments.length === 0) return undefined;

	const segments: KiwiPublicSegment[] = [];
	for (const sectorSegment of sectorSegments) {
		const segment = sectorSegment?.segment;
		if (!isObjectLike(segment)) return undefined;
		segments.push(segment);
	}

	for (let index = 1; index < segments.length; index += 1) {
		if (!isTechnicalStopBetween(segments[index - 1], segments[index])) return undefined;
	}
	return segments;
}

/**
 * The touchdowns between the first segment's departure and the last one's arrival, or
 * `undefined` when any of them cannot be timed honestly.
 *
 * Ground time is real elapsed time between two `LocalDateTime`s, never a subtraction of the
 * two wall-clock strings: a stop that lands at 23:50 and leaves at 00:40 crosses a date on
 * the airport clock, and treating a local reading as an instant is the bug AGENTS.md's
 * "Timezones" section exists to prevent. Both ends are the same airport so they share an
 * offset in practice, but nothing here depends on that being true.
 */
function technicalStopsBetween(segments: KiwiPublicSegment[]): TechnicalStop[] | undefined {
	const stops: TechnicalStop[] = [];
	for (let index = 1; index < segments.length; index += 1) {
		const arriving = segments[index - 1].destination;
		const leaving = segments[index].source;
		const airport = arriving?.station?.code;
		const timeZone = arriving?.station?.timezone;
		// `isTechnicalStopBetween` already proved both segments name the same airport, so
		// one zone is enough. A missing one is fatal here for the same reason it is fatal
		// on the two endpoints: a wrong offset is a wrong itinerary rather than no
		// itinerary.
		if (!isNonEmptyString(airport) || !isNonEmptyString(timeZone)) return undefined;
		if (!isParsableLocalIsoString(arriving?.localTime)) return undefined;
		if (!isParsableLocalIsoString(leaving?.localTime)) return undefined;

		const arrival = buildLocalDateTime(arriving.localTime, timeZone);
		const departure = buildLocalDateTime(leaving.localTime, timeZone);
		const groundTime = elapsedMinutes(arrival, departure);
		// A stop that leaves before it lands is a response this adapter does not
		// understand, and a negative ground time would shorten the trip's door-to-door
		// figure rather than lengthen it.
		if (groundTime <= 0) return undefined;

		stops.push({ airport, arrival, departure, groundTime: groundTime as Duration });
	}
	return stops;
}

/**
 * Maps one single-flight itinerary to a `FlightOffer`, or `undefined` when any field this
 * needs is missing, mistyped, or dishonest to guess at. Deliberately strict about the five
 * things a wrong value would corrupt silently rather than visibly: the price, the two
 * timezones, the flight number (which crosscheck.ts matches offers across providers on),
 * whether the segments really are one flight, and the timing of any stop in between.
 */
export function mapItineraryToFlightOffer(itinerary: KiwiPublicItinerary): FlightOffer | undefined {
	if (!isObjectLike(itinerary)) return undefined;

	const segments = singleFlightSegmentsOf(itinerary);
	if (!segments) return undefined;

	// One flight, so its identity, price and baggage come from the first segment while its
	// arrival comes from the last. Issue #210: for a nonstop these are the same segment and
	// everything below behaves exactly as it did before.
	const segment = segments[0];
	const lastSegment = segments[segments.length - 1];

	const technicalStops = technicalStopsBetween(segments);
	if (!technicalStops) return undefined;

	const source = segment.source;
	const destination = lastSegment.destination;
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

	// Gate to gate: every segment's airborne time plus every minute parked in between.
	//
	// Built from the parts rather than by subtracting the two endpoints, so the strict
	// per-segment validation above still applies to each one and a nonstop offer's duration
	// is byte-identical to what this mapper produced before issue #210. It agrees with
	// Kiwi's own itinerary total where that was checked: Neos NO4864 reports 25800s, and
	// 30min BVC-SID + 60min on the ground at Sal + 340min SID-FCO is 430min = 25800s.
	//
	// The ground time belongs in here and nowhere else. `algorithm/build.ts` adds the two
	// legs' durations to reach door-to-door, and it computes free time from this offer's
	// `arrival` — so an hour left out would shorten the trip, and an hour counted as
	// layover would offer the traveller a stopover inside an airport they cannot leave.
	let duration = 0;
	for (const each of segments) {
		const segmentDuration = parseKiwiDurationMinutes(each.duration);
		if (segmentDuration === undefined) return undefined;
		duration += segmentDuration;
	}
	for (const stop of technicalStops) duration += stop.groundTime;

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
		duration: duration as Duration,
		price,
		// Always one adult's fare, by construction — kiwi-public-queries.ts sends
		// `adults: 1` regardless of the real party size precisely so this is a fact rather
		// than an assumption (issue #109).
		priceScope: 'per-person',
		baggage: parseBaggage(itinerary.bagsInfo),
		// Omitted rather than set to `[]` on a nonstop, so a consumer that forgets to check
		// reads `undefined` (falsy, no stops) instead of an empty array (truthy object).
		...(technicalStops.length > 0 ? { technicalStops } : {}),
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
