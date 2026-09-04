/**
 * Pure mapping from Transitous's `/plan` response to the domain `Transfer` shape. No I/O,
 * no fetch, no cache — everything here is a plain function of its input so the "is there
 * service, and if not when's the next one" logic (issue #8's whole point) is exercised by
 * fixtures, not by a live call.
 *
 * Issue #135 gave this file the second half of that job: which departure is *the* one
 * depends on what was asked. For a leg that must reach a check-in deadline the answer is
 * the LAST departure that still makes it; for a leg that starts when a flight lands it is
 * the FIRST one after that. MOTIS returns both kinds in the same `itineraries` array and
 * does not sort it (a real 2026-10-04 arriveBy response came back 02:16, 02:17, 02:40,
 * 02:43, 02:31, 02:46, 03:08), which is also why the app used to print "13:28, 13:27" as
 * consecutive next departures.
 */

import type { Duration, LocalDateTime, Transfer, TransferLeg, TransferMode, TransitPlanMoment } from '../../domain';
import { maxPlausibleTransitMinutes } from '../../domain';
import { utcInstantToLocalDateTime } from './transitous-datetime';
import type { TransitousItinerary, TransitousLeg, TransitousPlace, TransitousPlanResponse } from './transitous-types';

/** How many of Transitous's own itineraries this adapter asks for per call: the intended
 * one plus a handful of following departures, per the brief's "the actual departures,
 * plus the next few after it." Exported so transitous-client.ts's request and this
 * mapper's "how many can `following` ever hold" agree without repeating the number. */
export const TRANSITOUS_NUM_ITINERARIES = 6;

/**
 * Issue #68: `transitous-client.ts`'s own shape check only confirms `itineraries` is an
 * array — nothing below that validates a single leg's `startTime`/`endTime` are parseable
 * instants or that `duration` is a real number. A schema drift on any of those would reach
 * `utcInstantToLocalDateTime` as `undefined` or a garbage string, producing an Invalid
 * Date that throws once `Intl.DateTimeFormat.formatToParts` touches it — this issue's
 * "Times" case, and one severe enough to crash the whole lookup rather than just mistime
 * it. `isValidItinerary` below is what lets this file drop one corrupted itinerary and try
 * the next, the "prefer dropping the bad item" rule issue #68 asks for given a real
 * captured-fixture baseline exists here (transitous-mapper.test.ts), unlike Kiwi's.
 */
export class TransitousMapMalformedResponseError extends Error {}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** `Date.parse` returns `NaN` for a string it cannot parse — this is the one guard standing
 * between a renamed/reformatted `startTime` and an Invalid Date reaching
 * `utcInstantToLocalDateTime`, which does not itself validate its input. */
function isParsableInstant(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isValidPlace(value: unknown): value is TransitousPlace {
	if (!isRecord(value)) return false;
	if (!isFiniteNumber(value.lat) || !isFiniteNumber(value.lon)) return false;
	if (value.tz !== undefined && typeof value.tz !== 'string') return false;
	return true;
}

function isValidLeg(value: unknown): value is TransitousLeg {
	if (!isRecord(value)) return false;
	return (
		typeof value.mode === 'string' &&
		isFiniteNumber(value.duration) &&
		isParsableInstant(value.startTime) &&
		isParsableInstant(value.endTime) &&
		isValidPlace(value.from) &&
		isValidPlace(value.to)
	);
}

/** An itinerary this file can map honestly end to end: a real duration, and at least one
 * leg, every one of which validates. One bad leg fails the whole itinerary (not just that
 * leg) because `mapPlanResponseToTransfer` maps every leg of the chosen itinerary into the
 * `Transfer` it returns — a `Transfer` missing one leg's timing is a shorter, wrong
 * itinerary, not a partial-but-honest one. */
function isValidItinerary(value: unknown): value is TransitousItinerary {
	if (!isRecord(value)) return false;
	return (
		isFiniteNumber(value.duration) &&
		Array.isArray(value.legs) &&
		value.legs.length > 0 &&
		value.legs.every(isValidLeg)
	);
}

/**
 * Issue #220: the modes that make an itinerary a flight rather than a ground transfer.
 *
 * `transitous-client.ts` already leaves `AIRPLANE` out of the modes it asks MOTIS to route
 * with, so on a healthy day nothing here has anything to drop. It runs anyway because a
 * query parameter is a request, not a guarantee. An older MOTIS behind the same URL, or a
 * feed whose route type lands on `AIRPLANE` some other way, and the app is back to quoting
 * the traveller a flight it already sold them under "Public transport" and adding its hours
 * to the door-to-door total.
 *
 * MOTIS's `Mode` enum has exactly one air value (openapi.yaml, read 2026-09-05), so this
 * set has one member. Guessing at names it does not define would only make the set look
 * more thorough than it is.
 */
const AIR_LEG_MODES: ReadonlySet<string> = new Set(['AIRPLANE']);

function containsAirLeg(itinerary: TransitousItinerary): boolean {
	return itinerary.legs.some((leg) => AIR_LEG_MODES.has(leg.mode));
}

const TRANSIT_MODE_LABELS: Record<string, string> = {
	BUS: 'Bus',
	COACH: 'Coach',
	SUBWAY: 'Metro',
	METRO: 'Metro',
	TRAM: 'Tram',
	RAIL: 'Train',
	REGIONAL_RAIL: 'Train',
	REGIONAL_FAST_RAIL: 'Train',
	LONG_DISTANCE: 'Train',
	HIGHSPEED_RAIL: 'Train',
	NIGHT_RAIL: 'Night train',
	FERRY: 'Ferry',
	CABLE_CAR: 'Cable car',
	GONDOLA: 'Gondola',
	FUNICULAR: 'Funicular'
};

/**
 * Builds the one `Transfer` this adapter ever returns for a query, or `undefined` when
 * Transitous found no transit route between the two points at all (as opposed to one that
 * merely departs later than asked for — see below).
 *
 * `undefined` here becomes an empty `Transfer[]` at the call site (transitous.ts), which
 * is itself a normal, non-error `ProviderResult` — "no connection exists" is data, same as
 * "the connection exists but not for another four hours" is.
 *
 * `plannedFor` is required, not optional (issue #135). It decides which of the returned
 * departures is the one the traveller is being told to catch, and it rides onto the
 * `Transfer` so nothing downstream can render a departure list without saying which journey
 * it belongs to. The gap arithmetic itself still lives outside this file
 * (`algorithm/transit-schedule.ts`), so a fixture only has to state what Transitous actually
 * said, not also encode a judgement call about what counts as "a gap."
 *
 * `straightLineKm` is issue #220's, and the two things it does here are deliberately not
 * the same thing:
 *
 * - An itinerary containing a flight is **dropped**. It is not a slow ground transfer, it
 *   is a different journey, and there is no honest way to render one as a leg of the trip
 *   the traveller has already been quoted.
 * - An itinerary merely too long for the distance (`maxPlausibleTransitMinutes`) is
 *   **deprioritised**, not dropped. MOTIS returns up to six and one absurd answer must not
 *   shadow five real ones, which it would if this file kept picking by departure time
 *   alone. If every answer is that long, the last one still comes back, so
 *   `search/resources.ts` is the single place that refuses it and the app can say what it
 *   refused and how long it was. A provider quietly returning nothing would leave the card
 *   claiming there is no service here, which is a different fact and not the one observed.
 */
export function mapPlanResponseToTransfer(
	response: TransitousPlanResponse,
	plannedFor: TransitPlanMoment,
	straightLineKm: number
): Transfer | undefined {
	const rawItineraries = response.itineraries ?? [];
	if (rawItineraries.length === 0) return undefined;

	const valid = rawItineraries.filter(isValidItinerary);
	if (valid.length === 0) {
		// Distinct from the `rawItineraries.length === 0` case above: Transitous DID answer
		// with itineraries, but not one of them had fields this file recognises — evidence
		// the schema drifted, not evidence there is simply no service. transitous.ts catches
		// this and reports `malformed-response` rather than the silent, wrong "no transfer
		// found" a traveller would otherwise see.
		throw new TransitousMapMalformedResponseError(
			'Transitous /plan returned itineraries, but none had the fields this adapter reads'
		);
	}

	// Runs before the duration rule below, and the order matters: a flight is never the
	// answer, however quick it looks, so an air itinerary must not be able to win on time.
	const ground = valid.filter((itinerary) => !containsAirLeg(itinerary));
	if (ground.length === 0) return undefined;

	const bound = maxPlausibleTransitMinutes(straightLineKm);
	const plausible = ground.filter((itinerary) => secondsToDuration(itinerary.duration) <= bound);
	const itineraries = plausible.length > 0 ? plausible : ground;

	const departures = orderedDepartures(itineraries);
	// Every itinerary Transitous puts in `itineraries` (as opposed to `direct`) should
	// contain at least one non-WALK leg by construction. Treating the case none does as "no
	// usable transfer" rather than fabricating a schedule from a walk leg keeps a future API
	// quirk from silently mislabelling a walk as a bus.
	if (departures.length === 0) return undefined;

	// The whole point of issue #135. Asked "get me there by 06:15", the answer is the LAST
	// departure MOTIS returned, because every one of them arrives in time and the traveller
	// wants the one that lets them leave latest. Asked "I am free from 23:55", it is the
	// FIRST. Taking `itineraries[0]` either way turned a 05:08 night bus into a 02:16 one.
	const chosenIndex = plannedFor.arriveBy ? departures.length - 1 : 0;
	const chosen = departures[chosenIndex];
	const lastLeg = chosen.itinerary.legs[chosen.itinerary.legs.length - 1];
	const boardingTime = (option: DepartureOption) =>
		toLocal(option.transitLeg.startTime, option.transitLeg.from.tz);

	return {
		mode: 'transit',
		duration: secondsToDuration(chosen.itinerary.duration),
		legs: chosen.itinerary.legs.map(mapLeg),
		transitSchedule: {
			intended: boardingTime(chosen),
			arrival: toLocal(chosen.itinerary.endTime, lastLeg.to.tz),
			// Empty on an `arriveBy` plan, and that emptiness is itself the answer rather
			// than a hole in the data: nothing later than the last departure arrives in
			// time. See `TransitSchedule.following`.
			following: departures.slice(chosenIndex + 1).map(boardingTime),
			earlier: plannedFor.arriveBy ? departures.slice(0, chosenIndex).map(boardingTime) : undefined,
			plannedFor
		}
	};
}

interface DepartureOption {
	itinerary: TransitousItinerary;
	transitLeg: TransitousLeg;
}

/**
 * Every itinerary that actually boards something, ordered by that boarding time, one entry
 * per distinct departure.
 *
 * MOTIS returns `itineraries` unordered — a real arriveBy response for Barcelona on
 * 2026-10-04 came back 02:16, 02:17, 02:40, 02:43, 02:31, 02:46, 03:08 — which is also how
 * the app came to print "13:28, 13:27" as consecutive next departures (issue #135).
 * Comparing the raw wire strings is exact here: they are all the same fixed-width UTC ISO
 * format from one response.
 *
 * Alternate routes sharing one departure minute (seen in a real night-time response)
 * collapse to the first, since "the next one after it" means a different bus, not a
 * different way of describing the same one.
 */
function orderedDepartures(itineraries: readonly TransitousItinerary[]): DepartureOption[] {
	const options: DepartureOption[] = [];
	for (const itinerary of itineraries) {
		const transitLeg = firstTransitLeg(itinerary);
		if (transitLeg) options.push({ itinerary, transitLeg });
	}
	options.sort((a, b) =>
		a.transitLeg.startTime < b.transitLeg.startTime
			? -1
			: a.transitLeg.startTime > b.transitLeg.startTime
				? 1
				: 0
	);

	const deduped: DepartureOption[] = [];
	for (const option of options) {
		if (deduped[deduped.length - 1]?.transitLeg.startTime === option.transitLeg.startTime) continue;
		deduped.push(option);
	}
	return deduped;
}

function toLocal(utcIso: string, timeZone: string | undefined): LocalDateTime {
	return utcInstantToLocalDateTime(utcIso, timeZone ?? 'UTC');
}

function firstTransitLeg(itinerary: TransitousItinerary): TransitousLeg | undefined {
	return itinerary.legs.find((leg) => leg.mode !== 'WALK');
}

function mapLeg(leg: TransitousLeg): TransferLeg {
	const mode: TransferMode = leg.mode === 'WALK' ? 'walk' : 'transit';
	return {
		mode,
		description: describeLeg(leg),
		// Issue #220: the same word `describeLeg` puts at the front of its sentence, kept as
		// its own field so a summary line can say "Bus, then metro" without pulling the
		// sentence apart again.
		vehicle: mode === 'transit' ? vehicleLabel(leg) : undefined,
		departure: utcInstantToLocalDateTime(leg.startTime, leg.from.tz ?? 'UTC'),
		arrival: utcInstantToLocalDateTime(leg.endTime, leg.to.tz ?? 'UTC'),
		duration: secondsToDuration(leg.duration)
	};
}

function vehicleLabel(leg: TransitousLeg): string {
	return TRANSIT_MODE_LABELS[leg.mode] ?? 'Transit';
}

/** Issue #8: "Include each leg's operator and line name so the timeline can name them." */
function describeLeg(leg: TransitousLeg): string | undefined {
	if (leg.mode === 'WALK') {
		return typeof leg.distance === 'number' ? `Walk (${Math.round(leg.distance)} m)` : 'Walk';
	}
	const kind = vehicleLabel(leg);
	const line = leg.routeShortName || leg.routeLongName;
	const label = line ? `${kind} ${line}` : kind;
	const withHeadsign = leg.headsign ? `${label} to ${leg.headsign}` : label;
	return leg.agencyName ? `${withHeadsign} (${leg.agencyName})` : withHeadsign;
}

function secondsToDuration(seconds: number): Duration {
	return Math.round(seconds / 60) as Duration;
}
