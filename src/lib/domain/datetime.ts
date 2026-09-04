/**
 * A calendar date with no time component, e.g. "2026-09-04". Used for the brief's
 * departure/arrival date bounds (lines 25-28), which are dates the traveller picks on a
 * calendar, not a specific wall-clock moment.
 */
export type IsoCalendarDate = string;

/** Wall-clock local date and time with no zone suffix, e.g. "2026-09-04T23:50:00". */
export type IsoLocalDateTimeString = string;

/**
 * A wall-clock date and time exactly as it reads on a clock at a specific airport, kept
 * together with that place's UTC offset. Never collapse this to a single UTC instant: a
 * 00:30 local arrival is still "today" on the airport clock but already "tomorrow" in
 * UTC, and normalising away the local value is how an overnight connection silently loses
 * a night — a lost night is a wrong price and a wrong hotel booking.
 *
 * AGENTS.md "Timezones": "Every flight time is a local wall-clock time at a specific
 * airport. Store the offset with it. Do not normalise everything to UTC and format it
 * back."
 * Issue #1: "departure/arrival as instants with the local timezone kept separately."
 */
export interface LocalDateTime {
	local: IsoLocalDateTimeString;
	/** IANA zone name for the airport, e.g. "Europe/Vienna". Needed alongside the numeric
	 * offset below because the same zone has more than one offset across the year (DST),
	 * and downstream code (e.g. the itinerary builder, issue #13) needs the zone name to
	 * reason about a DST change between two of these values. */
	timeZone: string;
	/** UTC offset in minutes at this specific local time, e.g. 120 for UTC+2 in summer.
	 * Stored rather than derived, so every consumer gets the correct offset without
	 * needing a timezone database of its own. */
	utcOffsetMinutes: number;
}
