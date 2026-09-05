/**
 * What one part of the trip strip says when you hover it, tap it, or arrow onto it.
 *
 * Issue #227, the owner: **"in the timeline previre i want to have tooltips that when i
 * hover a segment it shows the title, start time and end time, duration, and dynamic info
 * depending on the segment such as the flight number, airline or the hotel or info about
 * the transport."**
 *
 * The panel is the segment's own ticket stub: a tinted top half carrying the eyebrow, the
 * title and the two clocks, and a plain counterfoil carrying the facts. This module builds
 * everything printed on it, as data, so the wording can be asserted in a test rather than
 * read off a screenshot. `SegmentStub.svelte` arranges it and never decides what it says.
 *
 * ## One panel for the whole stopover, not one per day
 *
 * The owner settled that himself on the issue: **"so the sefments that are the free time
 * days they are just visual, they count as a larger segment free time, and they share the
 * same tooltip? and it includes the acoomodation info as dynamic info"**. Yes. The bed is
 * one booking across the whole stopover, and eleven copies of it is not information. So
 * `stripTargets` folds a run of free-time cells into one target, and its panel renders
 * `StopoverBlock`, the component issue #228 already built for exactly that content.
 *
 * ## Every number here is read, never recomputed
 *
 * - Clock readings are the segment's own `start`/`end`, which `trip-strip.ts` walked out
 *   of the two flights, through `formatClockTime`. Nothing here prints a time itself.
 * - A fare goes through `scaleFareForParty`, the same function `build.ts` totals with.
 *   `FlightOffer.price` on an itinerary is the provider's raw quote and is NOT pre-scaled:
 *   for two travellers on a Ryanair fare it is one adult's price, and printing it as it
 *   stands would understate the leg by half. The scope lives on the offer because the
 *   answer differs per provider (issue #109).
 * - A transfer fare goes through `transferFareNote`, which already separates
 *   the walk that is genuinely free from the ride nobody quoted (issue #212). Only the
 *   second is marked `unknown`, and neither is ever a blank or a zero (issue #204).
 * - "If you miss it" is `readMissedService`, the one reader of a `TransitSchedule`, so the
 *   panel and the expanded timeline can never disagree about whether that was the last bus.
 */

import { scaleFareForParty } from '$lib/algorithm/build';
import { readMissedService, readStaleSchedule } from '$lib/algorithm/transit-schedule';
import type {
	Airport,
	BaggageAllowance,
	Coordinates,
	Itinerary,
	LocalDateTime,
	Transfer,
	TransitLegField
} from '$lib/domain';
import {
	calendarDayOffset,
	formatCalendarDate,
	formatClockTime,
	formatDuration,
	formatLongDuration,
	formatMoney,
	formatUtcOffset
} from '$lib/format';
import { formatDistanceKm, haversineDistanceKm } from '$lib/stays/distance';
import { staleScheduleFact, transferDetailLine, transferFareNote } from './itinerary-timeline-format';
import { technicalStopDetail } from './technical-stop-note';
import { segmentIdOf, tripStrip } from './trip-strip';
import type { TripStripSegment, TripStripTransferSegment } from './trip-strip';
import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';

/** The four things a strip can be asked about. `transport` rather than the segment's own
 * `transfer` because that is the word the owner uses and the word the panel prints; the
 * price line's "Ground" is a separate inconsistency and not this issue's to fix. */
export type StubKind = 'flight' | 'wait' | 'transport' | 'stopover';

/** One thing on the strip a reader can point at, as a run of segments. Everything is one
 * segment except the stopover, whose day cells are a visual subdivision of one booking. */
export interface StripTarget {
	kind: StubKind;
	/** Index of the first strip segment covered. */
	from: number;
	/** Index of the last one, inclusive. */
	to: number;
}

export function stripTargets(segments: readonly TripStripSegment[]): StripTarget[] {
	const targets: StripTarget[] = [];
	segments.forEach((segment, index) => {
		if (segment.kind === 'free') {
			const previous = targets.at(-1);
			if (previous?.kind === 'stopover' && previous.to === index - 1) {
				previous.to = index;
				return;
			}
			targets.push({ kind: 'stopover', from: index, to: index });
			return;
		}
		targets.push({ kind: segment.kind === 'transfer' ? 'transport' : segment.kind, from: index, to: index });
	});
	return targets;
}

/** A clock reading with whatever the reader still needs to place it. */
export interface StubClock {
	/** Already through `formatClockTime`, so it honours the 24-hour setting. */
	time: string;
	code?: string;
	place?: string;
	/** Printed under the clock when this reading is not on the day in the eyebrow. */
	date?: string;
	/** "+1" beside the clock. Absent on a stopover, where spanning days is the headline
	 * rather than a surprise. */
	plusDays?: number;
}

export interface StubFact {
	label: string;
	value: string;
	/** A number nobody gave us: muted, so it does not read as a value. A free walk is not
	 * this, because walking costing nothing is a fact this app knows. */
	unknown?: boolean;
}

export interface StubNote {
	text: string;
	/** `warning` for the one thing that changes what the duration means: a technical stop
	 * sits inside the flight time and a reader who misses it plans the wrong day. */
	tone: 'plain' | 'warning';
}

export interface SegmentStub {
	kind: StubKind;
	/** "FLIGHT", "AIRPORT WAIT", "TRANSPORT", "STOPOVER". */
	eyebrow: string;
	/** The calendar day this part starts on, in the eyebrow's right corner. */
	day: string;
	title: string;
	notes: StubNote[];
	start: StubClock;
	end: StubClock;
	duration: string;
	/** The sentence under the clocks, when the clocks alone would mislead. Two segments
	 * have one: a flight whose ends keep different time, which is why 12:40pm to 8:30pm is
	 * honestly 5h 50m, and a wait, whose length is the traveller's own setting rather than
	 * a measured queue. It sits below the clocks rather than above them because the clocks
	 * are the loudest thing on the panel and an explanation must not push them down. */
	footnote?: string;
	facts: StubFact[];
	/** The stopover's counterfoil is `StopoverBlock`, which already owns the days, the bed,
	 * the rate and the transfer line. Writing a second one would grow a second answer. */
	rendersStopoverBlock: boolean;
	/** What the transparent hit target is called, before anyone opens the panel. */
	label: string;
}

export interface StubContext {
	itinerary: Itinerary;
	/** The stopover city's name, resolved by the page. The itinerary carries only a code. */
	connectionLabel: string;
	connectionCode: string;
	/** The stopover airport's record, once the page has it. Its name is what lets the wait
	 * panel say "London Gatwick", and its coordinates are what put a distance on the bed
	 * (issue #219). Both fall back to the code rather than to a guess. */
	connectionAirport?: Airport;
	/** The card is quiet because one of its airlines is one the traveller asked to avoid. */
	deprioritized?: boolean;
}

const EYEBROWS: Record<StubKind, string> = {
	flight: 'FLIGHT',
	wait: 'AIRPORT WAIT',
	transport: 'TRANSPORT',
	stopover: 'STOPOVER'
};

/** The city an airport code stands for, or `undefined` when this app cannot say. Only the
 * three airports an itinerary names are knowable, and the stopover's only once the page
 * has resolved the record; a code with no city attached prints alone. */
function placeOf(context: StubContext, code: string): string | undefined {
	const { itinerary, connectionCode, connectionLabel } = context;
	if (code === itinerary.originAirport.iataCode) return itinerary.originAirport.city.name;
	if (code === itinerary.destinationAirport.iataCode) return itinerary.destinationAirport.city.name;
	if (code === connectionCode) return connectionLabel === connectionCode ? undefined : connectionLabel;
	return undefined;
}

/** "London Gatwick LGW": the airport's own name plus its code, which is the whole point of
 * printing a code at all on a trip through a city with several airports. */
function airportTitle(context: StubContext, code: string): string {
	const { itinerary, connectionAirport, connectionCode } = context;
	if (code === itinerary.originAirport.iataCode) return `${itinerary.originAirport.name} ${code}`;
	if (code === itinerary.destinationAirport.iataCode) return `${itinerary.destinationAirport.name} ${code}`;
	if (code === connectionCode && connectionAirport) return `${connectionAirport.name} ${code}`;
	const place = placeOf(context, code);
	return place ? `${place} ${code}` : code;
}

function clockAt(reading: LocalDateTime, code?: string, place?: string): StubClock {
	return { time: formatClockTime(reading), code, place };
}

/** The end clock, with a date under it when it lands on another day. The `+1` stamp is a
 * warning, so the stopover does not get one: crossing midnight is what a stopover is for,
 * and a warning about the thing being sold reads as a defect. */
function endClock(start: LocalDateTime, end: LocalDateTime, clock: StubClock, stamped: boolean): StubClock {
	const days = calendarDayOffset(start, end);
	if (days === 0) return clock;
	return { ...clock, date: formatCalendarDate(end), plusDays: stamped ? days : undefined };
}

/**
 * Why the clocks do not subtract to the duration. Derived from the two stored offsets
 * rather than from the IANA names, so it is exact for these two instants, DST included.
 */
function offsetNote(start: LocalDateTime, end: LocalDateTime, startPlace: string, endPlace: string): string | undefined {
	const difference = end.utcOffsetMinutes - start.utcOffsetMinutes;
	if (difference === 0) return undefined;
	const direction = difference > 0 ? 'ahead of' : 'behind';
	return `Clocks are local. ${endPlace} (${formatUtcOffset(end.utcOffsetMinutes)}) is ${formatDuration(Math.abs(difference))} ${direction} ${startPlace} (${formatUtcOffset(start.utcOffsetMinutes)}).`;
}

/** "1 cabin, 1 checked", "1 cabin, no checked bag", "none included". Never a bare zero:
 * "0 checked" is a number where the traveller wants a yes or a no. */
function bagsValue(baggage: BaggageAllowance): string {
	const included: string[] = [];
	if (baggage.cabinBagsIncluded > 0) included.push(`${baggage.cabinBagsIncluded} cabin`);
	if (baggage.checkedBagsIncluded > 0) included.push(`${baggage.checkedBagsIncluded} checked`);
	if (included.length === 0) return 'none included';
	if (baggage.checkedBagsIncluded === 0) return `${included.join(', ')}, no checked bag`;
	return included.join(', ');
}

function flightStub(
	segment: Extract<TripStripSegment, { kind: 'flight' }>,
	context: StubContext
): SegmentStub {
	const { offer } = segment;
	const { travellers } = context.itinerary;
	const startPlace = placeOf(context, segment.from);
	const endPlace = placeOf(context, segment.to);
	const title = `${offer.carrier.name} ${offer.flightNumber}`;

	const notes: StubNote[] = [];
	const technicalStop = technicalStopDetail(offer);
	if (technicalStop) notes.push({ text: technicalStop, tone: 'warning' });
	// Colour is the only other channel carrying this, and WCAG 1.4.1 is explicit that it
	// can never be the only one. The card's own badge says it once; so does the panel a
	// reader opened precisely to find out what this flight is.
	if (context.deprioritized) notes.push({ text: 'An airline you asked to avoid.', tone: 'plain' });

	const facts: StubFact[] = [];
	const fare = formatMoney(scaleFareForParty(offer, travellers));
	const forParty = travellers > 1 ? ` for ${travellers}` : '';
	const brand = offer.fareBrand ? `, ${offer.fareBrand}` : '';
	facts.push({ label: 'Fare', value: `${fare}${forParty}${brand}` });
	facts.push({ label: 'Bags', value: bagsValue(offer.baggage) });
	// An absent fact is an absent row. "Aircraft unknown" is a row that says nothing.
	if (offer.aircraft) facts.push({ label: 'Aircraft', value: offer.aircraft });

	return {
		kind: 'flight',
		eyebrow: EYEBROWS.flight,
		day: formatCalendarDate(segment.start),
		title,
		notes,
		start: clockAt(segment.start, segment.from, startPlace),
		end: endClock(segment.start, segment.end, clockAt(segment.end, segment.to, endPlace), true),
		duration: formatDuration(segment.minutes),
		footnote: offsetNote(segment.start, segment.end, startPlace ?? segment.from, endPlace ?? segment.to),
		facts,
		rendersStopoverBlock: false,
		label: `Flight, ${title}, ${formatDuration(segment.minutes)}`
	};
}

function waitStub(segment: Extract<TripStripSegment, { kind: 'wait' }>, context: StubContext): SegmentStub {
	const title = airportTitle(context, segment.airport);
	const place = placeOf(context, segment.airport);
	const next = segment.beforeFlight;
	const to = placeOf(context, next.arrivalAirport) ?? next.arrivalAirport;

	return {
		kind: 'wait',
		eyebrow: EYEBROWS.wait,
		day: formatCalendarDate(segment.start),
		title,
		notes: [],
		start: clockAt(segment.start, segment.airport, place),
		// One place, so the end clock stands alone: printing the same code twice tells a
		// reader nothing they did not have.
		end: endClock(segment.start, segment.end, clockAt(segment.end), true),
		duration: formatDuration(segment.minutes),
		// AGENTS.md, on never presenting an estimate as a fact. This is the one part of the
		// schedule the traveller set themselves, so the panel says whose number it is and
		// where to change it instead of letting it read as a measured queue.
		footnote: `Your own buffer, not a measured queue. ${formatDuration(segment.minutes)} is the setting for this airport, and picking this wait is where you change it.`,
		facts: [
			{ label: 'Before', value: `${next.carrier.name} ${next.flightNumber} to ${to}, ${formatClockTime(next.departure)}` }
		],
		rendersStopoverBlock: false,
		label: `Airport wait, ${title}, ${formatDuration(segment.minutes)}`
	};
}

/** Where a ground leg is going, in the words the rest of the card uses. The leg into the
 * city names the property when one was priced, because that is the address the traveller
 * is actually walking to. */
function transferDestination(segment: TripStripTransferSegment, context: StubContext): string {
	const { itinerary, connectionLabel } = context;
	switch (segment.leg) {
		case 'to-origin-airport':
			return `to ${airportTitle(context, itinerary.originAirport.iataCode)}`;
		case 'to-city':
			return itinerary.stay ? `to ${itinerary.stay.property.name}` : `into ${connectionLabel}`;
		case 'to-connection-airport':
			return `to ${airportTitle(context, itinerary.onwardFlight.departureAirport)}`;
		case 'to-destination':
			return itinerary.destinationLocation ? `to ${itinerary.destinationLocation.label}` : 'to your destination';
	}
}

/** The airport end of a ground leg, which is the end worth stamping: the other end is a
 * street address the clock reading beside it already places. */
function transferAirportEnd(segment: TripStripTransferSegment): 'start' | 'end' {
	return segment.leg === 'to-origin-airport' || segment.leg === 'to-connection-airport' ? 'end' : 'start';
}

function transferAirportCode(segment: TripStripTransferSegment, context: StubContext): string {
	const { itinerary, connectionCode } = context;
	switch (segment.leg) {
		case 'to-origin-airport':
			return itinerary.originAirport.iataCode;
		case 'to-city':
		case 'to-connection-airport':
			return connectionCode;
		case 'to-destination':
			return itinerary.destinationAirport.iataCode;
	}
}

/** The road actually followed, when OSRM gave one. Summed along the polyline it already
 * returned, so it is that route's own length and not a straight line dressed up as one. */
function pathKm(path: Coordinates[] | undefined): number | undefined {
	if (!path || path.length < 2) return undefined;
	let total = 0;
	for (let index = 1; index < path.length; index += 1) total += haversineDistanceKm(path[index - 1]!, path[index]!);
	return total;
}

/** The two ends of a leg, when this app knows both. Transit legs carry no geometry, so a
 * straight line between the endpoints is all there is, and it says so rather than passing
 * itself off as a distance travelled. */
function legEndpoints(segment: TripStripTransferSegment, context: StubContext): [Coordinates, Coordinates] | undefined {
	const { itinerary, connectionAirport } = context;
	switch (segment.leg) {
		case 'to-origin-airport':
			return itinerary.originLocation
				? [itinerary.originLocation.coordinates, itinerary.originAirport.coordinates]
				: undefined;
		case 'to-city':
		case 'to-connection-airport':
			return connectionAirport && itinerary.stay
				? [connectionAirport.coordinates, itinerary.stay.property.coordinates]
				: undefined;
		case 'to-destination':
			return itinerary.destinationLocation
				? [itinerary.destinationAirport.coordinates, itinerary.destinationLocation.coordinates]
				: undefined;
	}
}

function distanceFact(segment: TripStripTransferSegment, context: StubContext): StubFact | undefined {
	const road = pathKm(segment.transfer.path);
	if (road !== undefined) return { label: 'Distance', value: formatDistanceKm(road) };
	const ends = legEndpoints(segment, context);
	if (!ends) return undefined;
	return { label: 'Distance', value: `${formatDistanceKm(haversineDistanceKm(ends[0], ends[1]))} straight line` };
}

/** The strip names its legs after where they go, the itinerary after the field that holds
 * them, and issue #266's staleness check keys on the second. */
function transitLegField(leg: TripStripTransferSegment['leg']): TransitLegField {
	switch (leg) {
		case 'to-origin-airport':
			return 'transferToOriginAirport';
		case 'to-city':
			return 'transferToHotel';
		case 'to-connection-airport':
			return 'transferToConnectionAirport';
		case 'to-destination':
			return 'transferToDestinationLocation';
	}
}

/** Brief line 84 and issue #135: missing the last bus is a first-class outcome, and the
 * strip is where somebody notices the gap. Never "there is no later bus", which is a claim
 * nobody observed; "nothing later was found" is the one that was. */
function missedFact(segment: TripStripTransferSegment, context: StubContext): StubFact | undefined {
	const { transfer } = segment;
	const schedule = transfer.transitSchedule;
	if (transfer.mode !== 'transit' || !schedule) return undefined;

	// Issue #266: a waiting-time edit or a flight swap moves the moment this leg happens at,
	// and neither can refetch the timetable, so every sentence below would be about a trip
	// that is no longer on screen. Say which moment it was planned for instead of answering
	// with its times.
	const staleAt = readStaleSchedule(context.itinerary, transitLegField(segment.leg));
	if (staleAt) {
		return {
			label: 'If you miss it',
			value: staleScheduleFact(schedule.plannedFor, staleAt),
			unknown: true
		};
	}

	const missed = readMissedService(schedule);
	if (missed.outcome === 'last-in-time') {
		return { label: 'If you miss it', value: `Nothing later arrives by ${formatClockTime(schedule.plannedFor.time)}` };
	}
	if (missed.outcome === 'last-known') {
		return { label: 'If you miss it', value: 'Nothing later was found', unknown: true };
	}
	if (missed.next === undefined || missed.gap === undefined) return undefined;
	return {
		label: 'If you miss it',
		value: `${formatClockTime(missed.next)}, ${formatDuration(missed.gap)} later`
	};
}

function transportStub(segment: TripStripTransferSegment, context: StubContext): SegmentStub {
	const { transfer } = segment;
	const title = `${transferDetailLine(transfer)} ${transferDestination(segment, context)}`;
	const code = transferAirportCode(segment, context);
	const stamped = transferAirportEnd(segment);
	const place = placeOf(context, code);

	const facts: StubFact[] = [];
	// Issue #227, the owner: every transport panel carries the fare. Where there is none,
	// which of the two absences it is (#212), never a blank and never a zero (#204).
	// Issue #249: a rate-card range counts as a value rather than an absence, so the panel
	// prints it plainly instead of greying out a number the app has.
	const fare = transferFareNote(transfer);
	facts.push({
		label: 'Fare',
		value: fare.estimated ? `${fare.text} (estimate)` : fare.text,
		unknown: fare.unknown
	});
	const distance = distanceFact(segment, context);
	if (distance) facts.push(distance);
	const missed = missedFact(segment, context);
	if (missed) facts.push(missed);

	const start = clockAt(segment.start, stamped === 'start' ? code : undefined, stamped === 'start' ? place : undefined);
	const bareEnd = clockAt(segment.end, stamped === 'end' ? code : undefined, stamped === 'end' ? place : undefined);

	return {
		kind: 'transport',
		eyebrow: EYEBROWS.transport,
		day: formatCalendarDate(segment.start),
		title,
		notes: [],
		start,
		end: endClock(segment.start, segment.end, bareEnd, true),
		duration: formatDuration(segment.minutes),
		footnote: undefined,
		facts,
		rendersStopoverBlock: false,
		label: `Transport, ${title}, ${formatDuration(segment.minutes)}`
	};
}

function stopoverStub(start: LocalDateTime, end: LocalDateTime, context: StubContext): SegmentStub {
	const { itinerary, connectionLabel, connectionCode, connectionAirport } = context;
	const nights = itinerary.nightsInConnection;
	const title =
		nights > 0
			? `${nights} ${nights === 1 ? 'night' : 'nights'} in ${connectionLabel}`
			: `Day stopover in ${connectionLabel}`;
	const free = `${formatLongDuration(itinerary.freeTime.duration)} free`;

	// Issue #219's whole complaint: the list ranks a bed 48 km out above one 2.8 km away
	// and shows no distance at all. `StopoverBlock` prints the leg's duration and fare; the
	// kilometres are the part it does not have, and the airport record is where they come
	// from, so this row appears only once the page has resolved it.
	const facts: StubFact[] = [];
	if (connectionAirport && itinerary.stay) {
		const km = haversineDistanceKm(connectionAirport.coordinates, itinerary.stay.property.coordinates);
		facts.push({ label: `From ${connectionCode}`, value: `${formatDistanceKm(km)} straight line` });
	}
	if (connectionAirport?.city.coordinates && itinerary.stay) {
		const km = haversineDistanceKm(connectionAirport.city.coordinates, itinerary.stay.property.coordinates);
		facts.push({ label: 'From centre', value: `${formatDistanceKm(km)} straight line` });
	}

	return {
		kind: 'stopover',
		eyebrow: EYEBROWS.stopover,
		day: formatCalendarDate(start),
		title,
		notes: [],
		start: clockAt(start, connectionCode, connectionLabel === connectionCode ? undefined : connectionLabel),
		end: endClock(start, end, clockAt(end), false),
		duration: free,
		footnote: undefined,
		facts,
		rendersStopoverBlock: true,
		label: `Stopover, ${title}, ${free}`
	};
}

/**
 * The stub for one target. Throws nothing and guesses nothing: a fact this app was not
 * given is a row that is absent or a row that says so, never an invented value.
 */
export function segmentStub(
	segments: readonly TripStripSegment[],
	target: StripTarget,
	context: StubContext
): SegmentStub {
	const first = segments[target.from]!;
	const last = segments[target.to]!;
	if (target.kind === 'stopover') return stopoverStub(first.start, last.end, context);
	if (first.kind === 'flight') return flightStub(first, context);
	if (first.kind === 'wait') return waitStub(first, context);
	return transportStub(first as TripStripTransferSegment, context);
}

/**
 * The same panel, asked for by segment rather than by strip position.
 *
 * Issue #278's customise rail is handed an `ItinerarySegmentId` and has to say which part
 * of the trip it is about before it offers to change it. It could have printed a title of
 * its own; it reads this instead, so the sentence over the picker and the sentence in the
 * strip's own preview are one sentence, decided once, with this module's tests behind it.
 *
 * `undefined` for the two segments the strip never draws. `origin-location` and
 * `destination-location` are places rather than stretches of time, so they have a timeline
 * row and no cell, and the rail falls back to its own heading for them.
 */
export function segmentStubFor(segment: ItinerarySegmentId, context: StubContext): SegmentStub | undefined {
	const strip = tripStrip(context.itinerary);
	const target = stripTargets(strip.segments).find((candidate) => segmentIdOf(strip, candidate.from) === segment);
	return target ? segmentStub(strip.segments, target, context) : undefined;
}
