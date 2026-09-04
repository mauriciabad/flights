/**
 * Pure mapping from Transitous's `/plan` response to the domain `Transfer` shape. No I/O,
 * no fetch, no cache — everything here is a plain function of its input so the "is there
 * service, and if not when's the next one" logic (issue #8's whole point) is exercised by
 * fixtures, not by a live call.
 */

import type { Duration, Transfer, TransferLeg, TransferMode } from '../../domain';
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
 * The gap itself is never computed here: `transitSchedule.intended` is simply the real
 * departure Transitous found, however far after the request that turns out to be. Whether
 * that counts as "waited five minutes for the bus" or "no service overnight" depends on
 * what the caller asked for (`TransferSearchQuery.departure`), which this function never
 * sees — diffing the two is the caller's job, and keeping that math out of here means a
 * fixture only has to state what Transitous actually said, not also encode a judgement
 * call about what counts as "a gap."
 */
export function mapPlanResponseToTransfer(response: TransitousPlanResponse): Transfer | undefined {
	const rawItineraries = response.itineraries ?? [];
	if (rawItineraries.length === 0) return undefined;

	const itineraries = rawItineraries.filter(isValidItinerary);
	if (itineraries.length === 0) {
		// Distinct from the `rawItineraries.length === 0` case above: Transitous DID answer
		// with itineraries, but not one of them had fields this file recognises — evidence
		// the schema drifted, not evidence there is simply no service. transitous.ts catches
		// this and reports `malformed-response` rather than the silent, wrong "no transfer
		// found" a traveller would otherwise see.
		throw new TransitousMapMalformedResponseError(
			'Transitous /plan returned itineraries, but none had the fields this adapter reads'
		);
	}

	const [chosen, ...rest] = itineraries;
	const chosenTransitLeg = firstTransitLeg(chosen);
	// Every itinerary Transitous puts in `itineraries` (as opposed to `direct`) should
	// contain at least one non-WALK leg by construction. Treating the case it somehow
	// doesn't as "no usable transfer" rather than fabricating a schedule from a walk leg
	// keeps a future API quirk from silently mislabelling a walk as a bus.
	if (!chosenTransitLeg) return undefined;

	const intendedUtc = chosenTransitLeg.startTime;
	const following = rest
		.map(firstTransitLeg)
		.filter(isDefined)
		// Transitous can list two itineraries with the identical departure (alternate
		// routes for the same trip, seen in a real night-time response). Those aren't
		// "the next one after it" — only strictly later departures qualify as "following".
		.filter((leg) => leg.startTime > intendedUtc)
		.map((leg) => utcInstantToLocalDateTime(leg.startTime, leg.from.tz ?? 'UTC'));

	return {
		mode: 'transit',
		duration: secondsToDuration(chosen.duration),
		legs: chosen.legs.map(mapLeg),
		transitSchedule: {
			intended: utcInstantToLocalDateTime(intendedUtc, chosenTransitLeg.from.tz ?? 'UTC'),
			following
		}
	};
}

function firstTransitLeg(itinerary: TransitousItinerary): TransitousLeg | undefined {
	return itinerary.legs.find((leg) => leg.mode !== 'WALK');
}

function mapLeg(leg: TransitousLeg): TransferLeg {
	const mode: TransferMode = leg.mode === 'WALK' ? 'walk' : 'transit';
	return {
		mode,
		description: describeLeg(leg),
		departure: utcInstantToLocalDateTime(leg.startTime, leg.from.tz ?? 'UTC'),
		arrival: utcInstantToLocalDateTime(leg.endTime, leg.to.tz ?? 'UTC'),
		duration: secondsToDuration(leg.duration)
	};
}

/** Issue #8: "Include each leg's operator and line name so the timeline can name them." */
function describeLeg(leg: TransitousLeg): string | undefined {
	if (leg.mode === 'WALK') {
		return typeof leg.distance === 'number' ? `Walk (${Math.round(leg.distance)} m)` : 'Walk';
	}
	const kind = TRANSIT_MODE_LABELS[leg.mode] ?? 'Transit';
	const line = leg.routeShortName || leg.routeLongName;
	const label = line ? `${kind} ${line}` : kind;
	const withHeadsign = leg.headsign ? `${label} to ${leg.headsign}` : label;
	return leg.agencyName ? `${withHeadsign} (${leg.agencyName})` : withHeadsign;
}

function secondsToDuration(seconds: number): Duration {
	return Math.round(seconds / 60) as Duration;
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}
