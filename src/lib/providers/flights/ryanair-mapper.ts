/**
 * Pure translation from Ryanair's raw response shapes (ryanair-types.ts) to this app's
 * domain shapes (src/lib/domain). No I/O, no cache, no fetch — everything here is a
 * function of its arguments, which is what makes ryanair-mapper.test.ts able to run
 * entirely off the fixtures in ./fixtures/ with no network.
 */

import type { BaggageAllowance, Carrier, FlightOffer, IataAirportCode, Money } from '../../domain';
import { moneyFromDecimalString } from '../../domain';
import { isSupportedTimeZone } from './airport-timezone';
import { computeFlightDuration, toLocalDateTime } from './ryanair-timezone';
import type { RyanairNetworkSnapshot } from '../../data/ryanair-network';
import type {
	RyanairActiveAirport,
	RyanairActiveAirportsResponse,
	RyanairCheapestPerDayResponse,
	RyanairDailyFare,
	RyanairMonthlyScheduleResponse,
	RyanairPrice,
	RyanairScheduledFlight
} from './ryanair-types';

/**
 * Ryanair Holdings flies under more than one AOC, and the timetable feed says which. STN→DUB
 * in October 2026 mixes `FR` and `RK` rows in the same month (measured 2026-09-04), so a
 * carrier hardcoded to "FR" would put a Ryanair UK flight number behind a Ryanair
 * (Ireland) carrier code on the itinerary — docs/ACCEPTANCE.md's "an offer whose airline the
 * sourcing provider does not fly" in miniature. `carrierFor` therefore takes the code from
 * the feed and only looks the NAME up here; an unrecognised code keeps its own code as its
 * name rather than being renamed to something this table cannot vouch for.
 */
const RYANAIR_GROUP_CARRIER_NAMES: Readonly<Record<string, string>> = {
	FR: 'Ryanair',
	RK: 'Ryanair UK',
	RR: 'Buzz',
	FA: 'Malta Air',
	LS: 'Lauda Europe'
};

export function carrierFor(carrierCode: string): Carrier {
	return { iataCode: carrierCode, name: RYANAIR_GROUP_CARRIER_NAMES[carrierCode] ?? carrierCode };
}

/** The fare calendar never mentions baggage, because every fare it quotes is
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
 * here and `mapDailyFaresToFlightOffers`'s loop, so one fare with a garbled or missing
 * date string would otherwise take down the whole batch instead of being the one fare this
 * file drops. */
function isParsableLocalIsoString(value: unknown): value is string {
	return isNonEmptyString(value) && !Number.isNaN(Date.parse(`${value}Z`));
}

/** Converts Ryanair's price to `Money`'s integer minor units using the two pre-split
 * decimal strings rather than `value` itself — `14.99 * 100` is not reliably `1499` in
 * floating point, and `valueMainUnit`/`valueFractionalUnit` exist precisely so a caller
 * never has to do that multiplication. Rejoining them into one decimal string hands
 * `moneyFromDecimalString` (domain/money.ts) the same digits Ryanair sent, and lets the
 * currency decide how many of them are minor units — two for the euro and for the forint
 * Ryanair prices Budapest fares in, none at all for a currency that has no minor unit
 * (issue #179). Returns `undefined`, rather than a `NaN` total, when either string is
 * missing or the wrong type (issue #93).
 * `valueFractionalUnit` may legitimately be `""`; `valueMainUnit` may not, since an empty
 * whole-unit string has no honest reading. */
export function toMoney(price: RyanairPrice | null): Money | undefined {
	if (
		!isRecord(price) ||
		!isNonEmptyString(price.valueMainUnit) ||
		typeof price.valueFractionalUnit !== 'string'
	) {
		return undefined;
	}
	const fraction = price.valueFractionalUnit === '' ? '' : `.${price.valueFractionalUnit}`;
	return moneyFromDecimalString(`${price.valueMainUnit}${fraction}`, price.currencyCode);
}

/** Ryanair does not publish a documented deep-link format for a specific fare; this
 * mirrors the query parameters its own site's flight-selection page reads (verified by
 * hand 2026-09-04: it 302-redirects into a live search pre-filled with these dates and
 * airports). Best-effort rather than contractual — re-check if Ryanair changes its
 * booking flow. */
function deepLinkFor(origin: string, destination: string, dateOut: string): string {
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
		originIata: origin,
		destinationIata: destination
	});
	return `https://www.ryanair.com/gb/en/trip/flights/select?${params.toString()}`;
}

/** `"2026-10-01T05:45:00"` -> `"05:45"`, the timetable's own `departureTime` format, so the
 * two feeds can be joined on it. */
function wallClockMinute(localIso: string): string {
	return localIso.slice(11, 16);
}

/**
 * The timetable indexed by the exact wall-clock minute a flight leaves, keyed
 * `"2026-10-01T05:45"` so a fare can only ever match a flight on its own date.
 *
 * Keyed by full date rather than by the feed's own day-of-month integer on purpose: the
 * day number alone is ambiguous across months, and pairing October's fares with November's
 * schedule would then quietly resolve to a real-looking flight number for a flight that
 * does not operate that day. `year`/`month` are the ones the schedule was FETCHED for, so
 * this cannot be reconstructed from the response body alone.
 */
export function buildScheduleIndex(
	schedule: RyanairMonthlyScheduleResponse,
	year: number,
	month: number
): Map<string, RyanairScheduledFlight> {
	const index = new Map<string, RyanairScheduledFlight>();
	if (!isRecord(schedule) || !Array.isArray(schedule.days)) return index;

	for (const scheduleDay of schedule.days) {
		if (!isRecord(scheduleDay) || !Array.isArray(scheduleDay.flights)) continue;
		if (typeof scheduleDay.day !== 'number' || !Number.isInteger(scheduleDay.day)) continue;
		const isoDay = `${year}-${String(month).padStart(2, '0')}-${String(scheduleDay.day).padStart(2, '0')}`;

		for (const flight of scheduleDay.flights) {
			if (!isRecord(flight)) continue;
			if (!isNonEmptyString(flight.carrierCode) || !isNonEmptyString(flight.number)) continue;
			if (!isNonEmptyString(flight.departureTime)) continue;
			// First entry wins. Two flights on one route leaving the same airport in the
			// same minute is not a real timetable, so this only ever guards against a
			// duplicated feed row.
			const key = `${isoDay}T${flight.departureTime}`;
			if (!index.has(key)) index.set(key, flight);
		}
	}
	return index;
}

export interface DailyFareRouteContext {
	/** From the REQUEST, not the response — `cheapestPerDay` echoes back neither airport,
	 * so these are the only place the offer's endpoints can honestly come from. */
	origin: IataAirportCode;
	destination: IataAirportCode;
	timeZoneByIataCode: Readonly<Record<string, string>>;
	/** Inclusive window the traveller actually asked about. The response always covers a
	 * whole calendar month whatever range was requested, so without this the search would
	 * offer flights on dates nobody asked for. */
	earliestDeparture: string;
	latestDeparture: string;
}

/**
 * `mapDailyFareToFlightOffer`'s return: the offer this day supports, when it supports one,
 * plus the airports that were the single thing between a sellable fare and a dated offer.
 *
 * Issue #359: an offer this app dropped for want of a time zone is not the same fact as a
 * day nothing was on sale, and until this shape existed the two arrived at the search
 * pipeline as the same empty list — which the connections map then printed as "Nothing
 * flies here" over a flight Ryanair had priced and named. Same shape, and the same reason
 * for it, as flights-sky-map-offers.ts's `DirectItineraryResult` (issues #124/#130).
 */
export interface DailyFareResult {
	offer?: FlightOffer;
	/** Populated only for a fare that was otherwise fully sellable: on sale, in the window,
	 * priced, and matched to a real timetable row. Never for a day rejected for any of those
	 * ordinary reasons, so a caller counting these can never mistake "Ryanair sells nothing
	 * that day" for "Ryanair sells this and this app cannot date it." */
	unresolvedTimeZoneAirports: readonly IataAirportCode[];
}

/**
 * Turns one day of the fare calendar into a `FlightOffer`, or into an empty result when
 * this day cannot be described honestly. Every rejection below is a real case measured
 * against the live endpoint on 2026-09-04, not defensive padding:
 *
 * - `unavailable` — nothing on sale. Also, and more importantly, what a route Ryanair does
 *   not fly at all looks like: BCN→OTP answers `200` with 31 unavailable rows. Mapping
 *   these would fabricate a month of flights on a route with no service, which
 *   docs/ACCEPTANCE.md ranks ahead of every feature as a bug.
 * - `soldOut` — the flight exists but this fare cannot be bought, so quoting its price
 *   would send a traveller to a booking they cannot complete.
 * - no matching timetable entry — the fare feed names no flight, so without the schedule's
 *   confirmation this offer would have to carry an invented flight number. `crosscheck.ts`
 *   matches providers on that number and the picker keys its rows on it; a made-up one is
 *   worse than one fewer row.
 * - unknown airport timezone — same judgement the adapter has always made (issue #93): a
 *   wrong UTC offset silently moves an overnight connection by a night. Checked last, and
 *   the only rejection this reports back, see `DailyFareResult`.
 */
export function mapDailyFareToFlightOffer(
	fare: RyanairDailyFare,
	schedule: ReadonlyMap<string, RyanairScheduledFlight>,
	context: DailyFareRouteContext
): DailyFareResult {
	const none: DailyFareResult = { unresolvedTimeZoneAirports: [] };
	if (!isRecord(fare)) return none;
	if (fare.unavailable === true || fare.soldOut === true) return none;
	if (!isNonEmptyString(fare.day)) return none;
	if (fare.day < context.earliestDeparture || fare.day > context.latestDeparture) return none;

	if (!isParsableLocalIsoString(fare.departureDate) || !isParsableLocalIsoString(fare.arrivalDate)) {
		return none;
	}

	const price = toMoney(fare.price);
	if (!price) return none;

	// The join. Departure minute is the identity: the fare feed is authoritative for the
	// times (it is what is actually on sale) and the schedule only supplies the name of the
	// flight leaving at that minute. Measured across 10 routes and 235 priced days on
	// 2026-09-04, every fare matched a scheduled departure, arrival times included.
	const scheduled = schedule.get(`${fare.day}T${wallClockMinute(fare.departureDate)}`);
	if (!scheduled) return none;

	// Last, after every other field has validated, which is what makes `DailyFareResult`'s
	// report worth anything: a fare with no price or no timetable row was never going to
	// become an offer, so naming its airports here would claim this app failed to time a
	// flight it never had. Same ordering, same reason, as flights-sky-map-offers.ts.
	const departureTimeZone = context.timeZoneByIataCode[context.origin];
	const arrivalTimeZone = context.timeZoneByIataCode[context.destination];
	if (!departureTimeZone || !arrivalTimeZone) {
		const unresolved: IataAirportCode[] = [];
		if (!departureTimeZone) unresolved.push(context.origin);
		if (!arrivalTimeZone) unresolved.push(context.destination);
		return { unresolvedTimeZoneAirports: unresolved };
	}

	const departure = toLocalDateTime(fare.departureDate, departureTimeZone);
	const arrival = toLocalDateTime(fare.arrivalDate, arrivalTimeZone);

	return {
		unresolvedTimeZoneAirports: [],
		offer: {
			carrier: carrierFor(scheduled.carrierCode),
			// Prefixed to match the format every other consumer already expects ("FR8231" from
			// the old fare finder), since the timetable splits the prefix off into carrierCode.
			flightNumber: `${scheduled.carrierCode}${scheduled.number}`,
			departureAirport: context.origin,
			arrivalAirport: context.destination,
			departure,
			arrival,
			duration: computeFlightDuration(departure, arrival),
			price,
			// Issue #109: `cheapestPerDay` has no adults/travellers parameter, and
			// ryanair-client.ts never sends one, so what comes back is one adult's fare by
			// construction rather than by assumption.
			priceScope: 'per-person',
			fareBrand: 'Basic',
			baggage: BASIC_FARE_BAGGAGE,
			deepLink: deepLinkFor(context.origin, context.destination, fare.day)
		}
	};
}

/** `mapDailyFaresToFlightOffers`'s return, gathering `DailyFareResult` across a whole month
 * of fares. Mirrors flights-sky-map-offers.ts's `MapSearchOneWayResult`. */
export interface MapDailyFaresResult {
	offers: FlightOffer[];
	unresolvedTimeZoneAirports: ReadonlySet<IataAirportCode>;
}

/**
 * A month of fares plus that month's timetable, joined into one offer per sellable day.
 *
 * Issue #137: this is the change that gives the flight picker something to pick. Its
 * predecessor asked `farfnd/v4/oneWayFares` for one route and got a single fare for the
 * whole window back, so a stopover was whatever date pair Ryanair happened to price
 * cheapest that minute and the traveller could not choose the number of nights.
 */
export function mapDailyFaresToFlightOffers(
	response: RyanairCheapestPerDayResponse,
	schedule: ReadonlyMap<string, RyanairScheduledFlight>,
	context: DailyFareRouteContext
): MapDailyFaresResult {
	const fares = response?.outbound?.fares;
	const offers: FlightOffer[] = [];
	const unresolvedTimeZoneAirports = new Set<IataAirportCode>();
	if (!Array.isArray(fares)) return { offers, unresolvedTimeZoneAirports };

	for (const fare of fares) {
		const result = mapDailyFareToFlightOffer(fare, schedule, context);
		if (result.offer) offers.push(result.offer);
		for (const code of result.unresolvedTimeZoneAirports) unresolvedTimeZoneAirports.add(code);
	}
	return { offers, unresolvedTimeZoneAirports };
}

/** Ryanair writes an airport edge in `RyanairActiveAirport.routes` as `airport:STN`. The
 * same array also carries `city:`, `country:`, `region:` and `connectingFlight:` entries,
 * which are search-widget facets rather than a route to one specific airport, so this
 * prefix is the only one naming something a fare provider can be asked about. */
const AIRPORT_ROUTE_PREFIX = 'airport:';

/**
 * A handful of entries carry a marketing carrier after a pipe — `airport:PMO|Air Malta`
 * on the Malta-Palermo pair, the only two in the whole feed on 2026-09-04. It is an
 * annotation, not a different route: the per-airport endpoint reports that same PMO leg
 * with `operator: "FR"` and no marker, and the feed also lists a plain `airport:PMO`
 * alongside it, which is why the caller de-duplicates. Keeping only the code before the
 * pipe matches what the old `mapRoutesToDestinations` did, which deliberately never
 * filtered on operator either.
 */
function iataCodeOf(entry: string): IataAirportCode {
	return entry.slice(AIRPORT_ROUTE_PREFIX.length).split('|')[0];
}

/** IATA codes of every airport reachable directly from `airport`, de-duplicated: issue
 * #12's connection graph wants a set of candidate airports, not a count of how many feed
 * entries mention each one.
 *
 * `seasonalRoutes` is present on every airport and empty on every one of them (checked
 * across all 224, 2026-09-04), and `routes` already carries the destinations the
 * per-airport endpoint marks seasonal. Unioned anyway, so the day Ryanair starts
 * populating that field a seasonal route shows up here instead of silently vanishing. */
function directDestinationsOf(airport: RyanairActiveAirport): IataAirportCode[] {
	const codes = new Set<IataAirportCode>();
	for (const entry of [...(airport.routes ?? []), ...(airport.seasonalRoutes ?? [])]) {
		if (typeof entry === 'string' && entry.startsWith(AIRPORT_ROUTE_PREFIX)) {
			codes.add(iataCodeOf(entry));
		}
	}
	return Array.from(codes);
}

/**
 * Projects Ryanair's ~220-airport active-airports response down to the two things this
 * adapter needs: which airports fly where, and each airport's IANA zone. The raw response
 * is 278 KB of categories, priority scores and city facets; the projection is under
 * 40 KB, and only the projection is ever cached.
 *
 * Issue #121: that one response IS the whole network, which is why this adapter no longer
 * asks `/views/locate/searchWidget/routes/en/airport/{IATA}` anything. Verified
 * 2026-09-04 — for BCN the `routes` array yields exactly the same 64 destination codes
 * that endpoint returns, and every airport Ryanair does not serve (ALG, DUS, EVN, IST,
 * LED) is absent from the response entirely, which is the same fact that endpoint spends
 * a 404 stating. So an origin missing from `destinationsByOrigin` means "not in Ryanair's
 * network", and no request has to be spent rediscovering that per airport per search.
 *
 * Issue #371: the two halves fill under different rules, so an airport can be in one and
 * not the other. That asymmetry is deliberate, and this is the one place that says so.
 *
 * An airport keeps its routes even when its zone is dropped. It stays a connection
 * candidate, and `pipeline.ts`'s `fetchLegs` asks every flight provider to price the leg,
 * not only Ryanair. Skyscanner, Flights Sky and Kiwi resolve zones through
 * `airport-timezone.ts`, a seed table plus a live Transitous lookup with no connection to
 * this feed, so an airport Ryanair described with a string `isSupportedTimeZone` rejects is
 * usually one they can time. Dropping it here would delete the city from the whole search
 * on the strength of one provider's bad string, and it would make `hasDirectRoute` answer
 * `false` about a route Ryanair genuinely flies. That is a wrong answer rather than a
 * missing one, and `no-results.ts` prints a different sentence to the traveller for it.
 *
 * What Ryanair itself cannot price is reported instead of hidden: `searchOffers` fails with
 * `no-time-zone` (#359) and the connections map says "A flight here could not be timed."
 * Losing a real stopover to a zone string nobody recognised is the cost this trades away.
 */
export function buildNetworkSnapshot(
	airports: RyanairActiveAirportsResponse,
	fetchedAt: string
): RyanairNetworkSnapshot {
	const destinationsByOrigin: Record<string, IataAirportCode[]> = {};
	const timeZonesByIataCode: Record<string, string> = {};
	for (const airport of airports) {
		if (!airport?.iataCode) continue;
		// Unconditional, and the line below is not. See this function's own comment: a route
		// this app cannot price itself is still a route, and still worth proposing.
		destinationsByOrigin[airport.iataCode] = directDestinationsOf(airport);
		// Issue #124: validated, not just present-checked. Ryanair's own feed is exactly the
		// kind of unvalidated provider string that already crashed a different adapter with
		// an uncaught `RangeError` when it turned out not to be a real IANA zone
		// (airport-timezone.ts's own header on the live "tz":"IANA" case) — the same class
		// of bug, not a Flights-Sky-specific one, so it gets the same guard here rather than
		// trusting this feed not to do the same thing on some future airport.
		if (airport.timeZone && isSupportedTimeZone(airport.timeZone)) {
			timeZonesByIataCode[airport.iataCode] = airport.timeZone;
		}
	}
	return { fetchedAt, destinationsByOrigin, timeZonesByIataCode };
}
