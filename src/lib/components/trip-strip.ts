/**
 * The compact trip strip: every part of an itinerary as one band, each part sized to how
 * long it takes.
 *
 * The results list needs a preview of the timeline that reads at a glance instead of a
 * text list. Issue #209 (the owner, verbatim: "the elements should be proportional to the
 * time they take and on the free time each day should be split (at midnight). and it
 * should also display the waiting time at airports and all transport times") makes the
 * strip carry the whole schedule the brief lists (docs/prompts/001, lines 44-53): the
 * ground leg to the origin airport, the wait there, the flight, the leg into the city,
 * the free time cut at every local midnight, the leg back, the wait, the flight, and the
 * leg on to the destination. Before it drew three spans and silently dropped the hours
 * between them, which are exactly the hours a traveller asks about.
 *
 * The arithmetic lives here rather than in the component so the split and the shares are
 * testable without mounting Svelte, and so every screen that wants the shape of a trip
 * draws the same bar from the same numbers.
 *
 * ## The scale: square root of minutes, and why not linear
 *
 * A linear strip cannot show this schedule at 335px (a 375px phone minus the card's
 * padding). A three-night stopover beside a 25-minute transfer is a 170:1 ratio, and the
 * transfer comes out at a pixel and a half. Every honest fix costs something:
 *
 * - A per-part floor with the remainder linear is what the three-span strip did. With
 *   ten or more parts the floors eat most of the bar, every short part lands on its floor
 *   and looks the same, and the result is a bar that claims to be linear and is not.
 * - A broken axis (full days drawn compressed with a break mark) keeps the hours linear,
 *   but a ten-hour morning then draws wider than the full day beside it, which reads as
 *   wrong before anyone reads the break mark.
 * - A square-root scale keeps every part visible and every comparison in the right
 *   direction: a longer part is always wider, a part twice as long is about 1.4 times as
 *   wide, and the full days stay the widest cells so nights are still countable. What it
 *   gives up is reading a ratio off the pixels, which is why the component prints the
 *   scale on the strip itself (issue #209: "if the scale is not linear, say so on
 *   screen") and why the durations that matter are printed as text beside it.
 *
 * Worked on the reference route (docs/prompts/007, BVC->LGW->PFO, one night): a 2h wait,
 * a 7h 50m flight, an evening of 2h 50m, a morning of 12h 40m, a 2h wait and a 6h 40m
 * flight come out at roughly 31, 62, 37, 79, 31 and 57px of 335. Linear would give 19,
 * 74, 27, 120, 19 and 63, with any 25-minute transfer at 4px. The picture is the same
 * shape; the short parts survive.
 *
 * ## Free time split at the stopover's own midnight
 *
 * Nights are what a traveller books, and "2d 15h free" does not say which days. The
 * free-time window is cut at every `00:00` on the stopover airport's own wall clock,
 * read straight off `LocalDateTime.local`, never off a UTC instant: AGENTS.md's timezone
 * rule, and the difference between "Friday evening, all Saturday, Sunday morning" and a
 * bar that loses a night. Each piece is measured in wall-clock minutes for the same
 * reason. A DST change inside the stopover makes one piece 60 minutes off its elapsed
 * time, and that piece is still the day the traveller lived through.
 */

import { addLocalMinutes, deriveLayover, deriveOriginLeg } from '$lib/algorithm/build';
import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
import type {
	Carrier,
	FlightOffer,
	IsoLocalDateTimeString,
	Itinerary,
	LocalDateTime,
	TransferMode,
	Transfer
} from '$lib/domain';

/** The one scale rule the strip draws with. Exported so the component prints it and the
 * tests pin it, not to offer a choice: see the header for what the alternatives cost. */
export const TRIP_STRIP_SCALE = 'sqrt' as const;

interface SegmentBase {
	/** Wall-clock minutes this part covers. Printed or spoken as text, so the scaled
	 * `share` below never has to be read as a measurement. */
	minutes: number;
	/**
	 * When this part begins and ends, each on the clock of the place it happens at
	 * (AGENTS.md: "all times should be in the local timezone of the place they reffer
	 * to"). A flight therefore starts on one clock and ends on another, and a segment
	 * whose two offsets differ is exactly the case a reader has to be told about, since
	 * `end - start` on the digits is then not the duration.
	 *
	 * Derived here rather than in a component (issue #227) by walking the schedule out
	 * from the two flights, which are the only readings the itinerary stores: everything
	 * else is a buffer or a leg measured against them. `build.ts` fixes the two ends of
	 * the stopover the same way, so `freeTime.start` and `freeTime.end` are used directly
	 * rather than re-derived, and the walk cannot drift from the window the rest of the
	 * app prints.
	 */
	start: LocalDateTime;
	end: LocalDateTime;
	/** Fraction of the bar's width on the square-root scale. Sums to 1 across the strip.
	 * The component floors each track at a few pixels so a very short part stays a
	 * visible seam; that floor is a CSS `minmax`, not a share adjustment. */
	share: number;
}

export interface TripStripTransferSegment extends SegmentBase {
	kind: 'transfer';
	mode: TransferMode;
	/** The leg itself, so a reader can print its route, its fare and its timetable
	 * without looking it up on the itinerary again and risking the wrong one. */
	transfer: Transfer;
	/** Which of the brief's four ground legs this is (docs/prompts/001, lines 45, 48, 50,
	 * 53), so the component can say where it goes without re-deriving it. */
	leg: 'to-origin-airport' | 'to-city' | 'to-connection-airport' | 'to-destination';
}

export interface TripStripWaitSegment extends SegmentBase {
	kind: 'wait';
	/** IATA code of the airport the traveller waits at. */
	airport: string;
	/** The flight this buffer is spent waiting for. A wait means nothing on its own; what
	 * a traveller wants to know is what it ends in. */
	beforeFlight: FlightOffer;
}

export interface TripStripFlightSegment extends SegmentBase {
	kind: 'flight';
	from: string;
	to: string;
	carrier: Carrier;
	/** The offer itself: its number, fare, baggage, aircraft and technical stops. */
	offer: FlightOffer;
}

export interface TripStripFreeSegment extends SegmentBase {
	kind: 'free';
	/** Calendar date on the stopover's own clock, `YYYY-MM-DD`. The piece's two ends are
	 * `start` and `end` on the base, both on the stopover's clock; a piece that ends at
	 * midnight ends at `T00:00:00` of the next date, the way a hotel night does. */
	date: string;
	/** `true` when this piece runs from one local midnight to the next. */
	wholeDay: boolean;
	/** `true` when the piece begins at 00:00: a morning after a night, or a whole day. */
	startsAtMidnight: boolean;
	/** `true` when the piece ends at 00:00: an evening before a night, or a whole day. */
	endsAtMidnight: boolean;
}

export type TripStripSegment =
	| TripStripTransferSegment
	| TripStripWaitSegment
	| TripStripFlightSegment
	| TripStripFreeSegment;

/** `Omit` applied to each member of a union in turn. A plain `Omit` on a union keeps only
 * the keys every member shares, which would drop each segment's own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A segment before its share of the bar is known. */
type Unshared = DistributiveOmit<TripStripSegment, 'share'>;

export interface TripStrip {
	segments: TripStripSegment[];
	/** Every segment's minutes added up: door to door when every ground leg is present,
	 * airport to airport when none is. */
	totalMinutes: number;
	/** Index of the outbound flight in `segments`. The stopover starts right after it. */
	outboundIndex: number;
	/** Index of the onward flight in `segments`. The stopover ends right before it. */
	onwardIndex: number;
	scale: typeof TRIP_STRIP_SCALE;
}

/**
 * Distributes `1` across the given minutes on a square-root scale. Order-preserving by
 * construction (a longer part is always wider), and an all-zero input splits evenly rather
 * than dividing by zero: a degenerate itinerary with no measurable time in it has no
 * honest picture but an equal one.
 *
 * Exported for its own tests. The invariants worth pinning (sums to 1, order preserved,
 * a quadrupled part exactly doubles) are properties of this function, not of a component.
 */
export function sqrtShares(minutes: readonly number[]): number[] {
	if (minutes.length === 0) return [];
	const weights = minutes.map((value) => Math.sqrt(Math.max(value, 0)));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	if (total <= 0) return weights.map(() => 1 / weights.length);
	return weights.map((weight) => weight / total);
}

/** Wall-clock minutes since the Unix epoch, treating the local digits as if they were
 * UTC. Deliberately not the real instant: two readings on the same airport clock differ
 * by the minutes that clock ticked through, which is what a day on the strip means. */
function wallClockMinutes(local: string): number {
	return Date.parse(`${local}Z`) / 60_000;
}

function isoLocal(wallMinutes: number): IsoLocalDateTimeString {
	return new Date(wallMinutes * 60_000).toISOString().slice(0, 19);
}

function isoDate(wallMinutes: number): string {
	return isoLocal(wallMinutes).slice(0, 10);
}

/** The local midnight that starts the calendar day containing `wallMinutes`. */
function startOfDay(wallMinutes: number): number {
	return Date.parse(`${isoDate(wallMinutes)}T00:00:00Z`) / 60_000;
}

/** A reading inside the stopover, carrying the stopover's own zone. Every free-time piece
 * is cut off `freeTime.start`'s wall clock, so it belongs to that clock and to no other:
 * rebuilding it against the viewer's zone is how an overnight loses a night (AGENTS.md). */
function atStopoverClock(window: LocalDateTime, local: IsoLocalDateTimeString): LocalDateTime {
	return { local, timeZone: window.timeZone, utcOffsetMinutes: window.utcOffsetMinutes };
}

/** One piece of a free-time window, before it gets a share of the bar. */
export interface FreeTimePiece {
	date: string;
	start: IsoLocalDateTimeString;
	end: IsoLocalDateTimeString;
	minutes: number;
	wholeDay: boolean;
	startsAtMidnight: boolean;
	endsAtMidnight: boolean;
}

/**
 * Cuts a free-time window at every local midnight between its two readings. Both
 * readings are on the stopover airport's own clock (`build.ts` derives them from the two
 * flights' own arrival and departure at that airport), so the cut is read straight off
 * the `local` string and never touches the UTC offset.
 *
 * Zero-length pieces are dropped: a window that starts exactly at midnight begins with the
 * morning, not with an empty evening. A window with no length at all yields no pieces.
 * A window whose end precedes its start is a pipeline defect (`build.ts` filters those)
 * and also yields nothing rather than a piece with negative minutes.
 */
export function splitFreeTimeAtLocalMidnight(start: LocalDateTime, end: LocalDateTime): FreeTimePiece[] {
	const startMinutes = wallClockMinutes(start.local);
	const endMinutes = wallClockMinutes(end.local);
	if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) return [];

	const pieces: FreeTimePiece[] = [];
	let cursor = startMinutes;
	while (cursor < endMinutes) {
		const dayStart = startOfDay(cursor);
		const midnight = dayStart + 24 * 60;
		const pieceEnd = Math.min(midnight, endMinutes);
		const startsAtMidnight = cursor === dayStart;
		const endsAtMidnight = pieceEnd === midnight;
		pieces.push({
			date: isoDate(cursor),
			start: isoLocal(cursor),
			end: isoLocal(pieceEnd),
			minutes: pieceEnd - cursor,
			wholeDay: startsAtMidnight && endsAtMidnight,
			startsAtMidnight,
			endsAtMidnight
		});
		cursor = pieceEnd;
	}
	return pieces;
}

/**
 * Every part of the itinerary in schedule order, with its real minutes and its share of
 * the bar. Ground legs appear only when the itinerary has them: `search/resources.ts`
 * looks up the two connection-side transfers only when there is a bed or a checked city
 * point to route to, and the outer two only when the query carried a location. A missing
 * leg is not drawn as an empty cell, because an empty cell would claim a duration of zero
 * for a leg nobody measured.
 *
 * The two waiting cells are what the rides on either side of them leave, not the buffers
 * the traveller set (`WaitingTimeRule`), which are only ever a minimum: issues #368 and
 * #399. They are drawn because they are time the traveller spends at the airport, which
 * the brief counts separately from flying and from free time (line 58).
 */
export function tripStrip(itinerary: Itinerary): TripStrip {
	const {
		transferToOriginAirport,
		originAirport,
		outboundFlight,
		transferToHotel,
		freeTime,
		transferToConnectionAirport,
		onwardFlight,
		transferToDestinationLocation
	} = itinerary;
	// Issue #368: the three cells between the two flights are the layover's own pieces, and
	// `build.ts` is the one place that splits it. Reading `Transfer.duration` and
	// `connectionWaitingTime` here instead put a 67-minute cell across a 2h 35m gap on the
	// strip, because the metro the app picked leaves an hour and a half before the
	// subtraction says it does.
	const layover = deriveLayover(itinerary);
	// Issue #399, the same split at the other end of the trip and for the same reason.
	const originLeg = deriveOriginLeg(itinerary);

	const parts: Unshared[] = [];

	// The whole schedule hangs off four stored readings: the two flights' departures and
	// arrivals. Everything around them is a timetable or a buffer measured against one of
	// those, so each part below is anchored to the flight beside it rather than accumulated
	// from the front, where one absent leg would shift every later clock.
	if (transferToOriginAirport) {
		parts.push({
			kind: 'transfer',
			mode: transferToOriginAirport.mode,
			transfer: transferToOriginAirport,
			leg: 'to-origin-airport',
			// Boarding to arrival, which is the ride as the timetable runs it, never
			// `Transfer.duration` on its own.
			minutes: originLeg.toAirport,
			start: originLeg.departure,
			end: originLeg.atAirport
		});
	}
	parts.push({
		kind: 'wait',
		airport: originAirport.iataCode,
		beforeFlight: outboundFlight,
		// `originLeg.airportWait`, which is what `times.originAirportWaiting` is built from,
		// rather than the stored buffer: the cell beside this one comes off the same call,
		// and a strip that mixed a stored number with a derived one is the drift issue #399
		// is about.
		minutes: originLeg.airportWait,
		start: originLeg.atAirport,
		end: outboundFlight.departure
	});
	const outboundIndex = parts.length;
	parts.push({
		kind: 'flight',
		from: outboundFlight.departureAirport,
		to: outboundFlight.arrivalAirport,
		carrier: outboundFlight.carrier,
		offer: outboundFlight,
		minutes: outboundFlight.duration,
		start: outboundFlight.departure,
		end: outboundFlight.arrival
	});
	if (transferToHotel) {
		parts.push({
			kind: 'transfer',
			mode: transferToHotel.mode,
			transfer: transferToHotel,
			leg: 'to-city',
			// Landing to `freeTime.start`, which is the leg plus any wait for the service
			// that runs it, never `Transfer.duration` on its own.
			minutes: layover.intoTown,
			start: outboundFlight.arrival,
			end: freeTime.start
		});
	}
	for (const piece of splitFreeTimeAtLocalMidnight(freeTime.start, freeTime.end)) {
		const { start, end, ...rest } = piece;
		parts.push({
			kind: 'free',
			...rest,
			start: atStopoverClock(freeTime.start, start),
			end: atStopoverClock(freeTime.start, end)
		});
	}
	if (transferToConnectionAirport) {
		parts.push({
			kind: 'transfer',
			mode: transferToConnectionAirport.mode,
			transfer: transferToConnectionAirport,
			leg: 'to-connection-airport',
			minutes: layover.backToAirport,
			start: freeTime.end,
			end: layover.atAirport
		});
	}
	parts.push({
		kind: 'wait',
		airport: onwardFlight.departureAirport,
		beforeFlight: onwardFlight,
		// `layover.airportWait`, which is what `times.connectionAirportWaiting` is built from,
		// rather than the stored field: every other cell here comes off this one call, and a
		// strip that mixed a stored number with a derived one is the drift this issue is about.
		minutes: layover.airportWait,
		start: layover.atAirport,
		end: onwardFlight.departure
	});
	const onwardIndex = parts.length;
	parts.push({
		kind: 'flight',
		from: onwardFlight.departureAirport,
		to: onwardFlight.arrivalAirport,
		carrier: onwardFlight.carrier,
		offer: onwardFlight,
		minutes: onwardFlight.duration,
		start: onwardFlight.departure,
		end: onwardFlight.arrival
	});
	if (transferToDestinationLocation) {
		parts.push({
			kind: 'transfer',
			mode: transferToDestinationLocation.mode,
			transfer: transferToDestinationLocation,
			leg: 'to-destination',
			minutes: transferToDestinationLocation.duration,
			start: onwardFlight.arrival,
			end: addLocalMinutes(onwardFlight.arrival, transferToDestinationLocation.duration)
		});
	}
	const minutes = parts.map((part) => Math.max(0, part.minutes));
	const shares = sqrtShares(minutes);
	const segments = parts.map((part, index) => ({ ...part, share: shares[index]! }) as TripStripSegment);

	return {
		segments,
		totalMinutes: minutes.reduce((sum, value) => sum + value, 0),
		outboundIndex,
		onwardIndex,
		scale: TRIP_STRIP_SCALE
	};
}

/**
 * Which stretch of the itinerary a strip segment stands for, in the vocabulary
 * `ItineraryMap` and `ItineraryTimeline` already share (`itinerary-map/segment-id.ts`).
 *
 * Issue #278 gave the strip a selection, and a selection is only worth anything if the
 * other two surfaces agree what was picked. They already agree with each other on eleven
 * strings; this is the one translation the strip needed, and it is a translation rather
 * than a second vocabulary because inventing a third set of names is how #243 and #250
 * happened.
 *
 * A transfer knows its own leg. A flight and a wait do not, so both read their position
 * against the two flight indices the strip already computes: everything before
 * `outboundIndex` belongs to the origin, everything after it to the connection.
 *
 * Free time maps to `free-time`, which is what the timeline calls the stopover row and
 * what `ResultDetail` has always keyed the stay picker on, so a run of day cells and the
 * timeline's one stopover row select each other.
 */
export function segmentIdOf(strip: TripStrip, index: number): ItinerarySegmentId {
	const segment = strip.segments[index];
	if (!segment) throw new Error(`no strip segment at ${index}`);
	switch (segment.kind) {
		case 'free':
			return 'free-time';
		case 'transfer':
			return TRANSFER_LEG_SEGMENT_IDS[segment.leg];
		case 'flight':
			return index === strip.outboundIndex ? 'outbound-flight' : 'onward-flight';
		case 'wait':
			return index < strip.outboundIndex ? 'origin-waiting' : 'connection-waiting';
	}
}

const TRANSFER_LEG_SEGMENT_IDS: Record<TripStripTransferSegment['leg'], ItinerarySegmentId> = {
	'to-origin-airport': 'transfer-to-origin-airport',
	'to-city': 'transfer-to-hotel',
	'to-connection-airport': 'transfer-to-connection-airport',
	'to-destination': 'transfer-to-destination-location'
};
