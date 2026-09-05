/**
 * Issue #324's calendar half: for one connection, which days each of its two legs is known
 * to fly on.
 *
 * The owner: **"calendar with days that have flights and days that dont"**.
 *
 * ## Zero requests, by instruction
 *
 * Everything here is a read of `$lib/flexible-dates`'s `collectLegFares`, which is the
 * price ledger plus Ryanair's cached `cheapestPerDay` month grids out of IndexedDB, and
 * whose own doc comment says "Zero requests, always". Nothing in this file may ever grow a
 * fetch. The owner pays nothing by instruction (AGENTS.md), and a per-connection calendar
 * that asked a provider would multiply one dialog into one request per stopover per month.
 *
 * ## Three states, and the third is the point
 *
 * A day is priced, blank, or unknown. Blank means a source said so, and it carries which
 * source and which of the two things it said: `'no-service'` (nothing flies this route that
 * day) and `'sold-out'` (something does, and it is gone) are different answers, and only one
 * of them is worth changing your dates over. Unknown means nobody has looked, which is not a
 * day without flights. Drawing unknown as empty would turn "we have not asked about
 * November" into "November has no flights", and this whole feature exists to stop the app
 * doing exactly that kind of thing on a map.
 *
 * ## The two legs are shown side by side, never correlated
 *
 * An outbound on the 3rd pairs with an onward on the 3rd, the 4th or the 9th, depending on
 * how long the traveller stops. Multiplying the two strips together to produce "days this
 * whole trip is available" would state a combination no provider quoted. So each leg gets
 * its own strip and the reader does the joining, which is the honest arrangement and also
 * the one that shows WHICH leg is the problem.
 */

import type { IataAirportCode, IsoCalendarDate, IsoCurrencyCode } from '../domain';
import { addDays, collectLegFares, monthStartsBetween } from '../flexible-dates';
import type { BlankDayReason, CollectOptions, LegFares } from '../flexible-dates';

export type DayState = 'priced' | 'blank' | 'unknown';

export interface CalendarDay {
	date: IsoCalendarDate;
	state: DayState;
	/** Only on a blank day: what the source actually said. */
	reason?: BlankDayReason;
	/** Only on a priced day: the cheapest one-adult fare in minor units, and who said so.
	 * Not a bookable quote, which is why the panel prints it as "cheapest seen" and dates
	 * it. */
	minorUnits?: number;
	providerId?: string;
}

export interface LegCalendar {
	origin: IataAirportCode;
	destination: IataAirportCode;
	currency: IsoCurrencyCode;
	/** Every date in the search window, in order, with no gaps. A missing entry would be a
	 * fourth state nobody defined. */
	days: CalendarDay[];
	priced: number;
	blank: number;
	unknown: number;
	/** Epoch millis of the newest observation behind any day here, so the panel can date
	 * the strip. Absent when the whole window is unknown. */
	newestObservation?: number;
}

export interface ConnectionCalendar {
	outbound: LegCalendar;
	onward: LegCalendar;
}

export interface CalendarWindow {
	/** First date the strip covers, inclusive. */
	from: IsoCalendarDate;
	/** Last date the strip covers, inclusive. */
	to: IsoCalendarDate;
}

/** Every date from `from` to `to` inclusive. Returns `[from]` for a reversed window rather
 * than looping forever or returning nothing: a strip of one day is a visible wrong answer,
 * an empty strip reads as "no flights". */
function datesInWindow(window: CalendarWindow): IsoCalendarDate[] {
	const dates: IsoCalendarDate[] = [];
	let cursor = window.from;
	// The step ceiling is a stop, not a limit anybody should reach. A search window is a
	// trip, so two years of days is far past any real one, and a malformed date that
	// `addDays` cannot advance would otherwise spin here forever.
	for (let step = 0; step < 732 && cursor <= window.to; step += 1) {
		dates.push(cursor);
		cursor = addDays(cursor, 1);
	}
	return dates.length > 0 ? dates : [window.from];
}

/** Turns one leg's cached fares into one day per date in the window. */
export function legCalendarFrom(fares: LegFares, window: CalendarWindow): LegCalendar {
	const priced = new Map(fares.fares.map((fare) => [fare.departureDate, fare]));
	const blanks = new Map(fares.blankDays.map((blank) => [blank.date, blank]));

	let newestObservation: number | undefined;
	const note = (observedAt: number): void => {
		if (newestObservation === undefined || observedAt > newestObservation) newestObservation = observedAt;
	};

	const days: CalendarDay[] = datesInWindow(window).map((date) => {
		const fare = priced.get(date);
		if (fare) {
			note(fare.observedAt);
			return { date, state: 'priced', minorUnits: fare.minorUnits, providerId: fare.providerId };
		}
		const blank = blanks.get(date);
		if (blank) {
			note(blank.observedAt);
			return { date, state: 'blank', reason: blank.reason };
		}
		return { date, state: 'unknown' };
	});

	return {
		origin: fares.origin,
		destination: fares.destination,
		currency: fares.currency,
		days,
		priced: days.filter((day) => day.state === 'priced').length,
		blank: days.filter((day) => day.state === 'blank').length,
		unknown: days.filter((day) => day.state === 'unknown').length,
		newestObservation
	};
}

export interface ConnectionCalendarRequest {
	originAirport: IataAirportCode;
	connectionAirport: IataAirportCode;
	destinationAirport: IataAirportCode;
	currency: IsoCurrencyCode;
	window: CalendarWindow;
}

/**
 * Both of one connection's legs, read out of the cache. Never fetches.
 *
 * Called lazily, for the one connection the panel is showing, rather than for all of them
 * when the dialog opens. Twenty stopovers is forty of these and each is several IndexedDB
 * reads; the traveller looks at three.
 */
export async function readConnectionCalendar(
	request: ConnectionCalendarRequest,
	options: CollectOptions = {}
): Promise<ConnectionCalendar> {
	const months = monthStartsBetween(request.window.from, request.window.to);
	const [outbound, onward] = await Promise.all([
		collectLegFares(
			{ origin: request.originAirport, destination: request.connectionAirport, currency: request.currency },
			months,
			options
		),
		collectLegFares(
			{ origin: request.connectionAirport, destination: request.destinationAirport, currency: request.currency },
			months,
			options
		)
	]);
	return {
		outbound: legCalendarFrom(outbound, request.window),
		onward: legCalendarFrom(onward, request.window)
	};
}
