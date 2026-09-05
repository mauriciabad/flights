/**
 * A stopover's free time as the traveller counts it: which whole days he gets, and the two
 * edges around them.
 *
 * Issue #228. A stopover used to read "2d 15h free", and the owner's objection to that is
 * the whole issue: a duration answers "how long", and the question a person asks about a
 * stopover is "how many days do I get, and when do they start and stop". He settled the
 * shape himself:
 *
 * > Fri 9 from 9:10pm
 * > 2 full days: Sat, Sun
 * > Mon 12 until 9:05am
 *
 * ## The rules he set, and the one he pointedly did not
 *
 * **No explanatory text.** He rejected drafts that wrote "still counts" and "too late to
 * count" beside a line. The middle line lists the whole days and the edge lines give the
 * two clock readings; a day that appears in both is simply true, and needs no sentence.
 *
 * **"No full days", plural, when there are none.** Not "0 full days", which reads as a bug
 * or an empty state rather than as an answer, and not the singular.
 *
 * **Land before 5am and that day still counts.** The one exception, and it is on the
 * arrival edge only. His own worked case leaves for the airport at 4am and still does not
 * count that day, so there is no mirror on the departure side and none is invented here.
 *
 * ## Why the edges are the free-time window and not the two flights
 *
 * `build.ts` already folds the flight times, the airport waiting rule and the ground
 * transfer into `freeTime.start` and `freeTime.end`, so `end` is the moment you leave for
 * the airport rather than the moment the plane leaves. That is exactly the number #228
 * asks these lines to name, and it is already what the expanded timeline prints two rows
 * away, so reading it from anywhere else would put two different answers on one screen.
 */

import type { LocalDateTime } from '$lib/domain';
import { formatClockTime, formatWeekday, formatWeekdayAndDay } from '$lib/format';
import type { FreeTimePiece } from './trip-strip';
import { splitFreeTimeAtLocalMidnight } from './trip-strip';

/** Land before this and the arrival day is still a full day, per the owner on #228. */
const FULL_DAY_ARRIVAL_CUTOFF_MINUTES = 5 * 60;

/** Past a week the weekday names repeat, and "Mon, Tue, Wed, Thu, Fri, Sat, Sun, Mon" no
 * longer names a day. A span does. */
const MAX_LISTED_FULL_DAYS = 7;

export interface FreeTimeDays {
	/** "Fri 9 from 9:10pm" */
	from: string;
	/** "2 full days" | "1 full day" | "No full days", for a cell with one line to give. */
	count: string;
	/** "2 full days: Sat, Sun" | "No full days" */
	fullDays: string;
	/** "Mon 12 until 9:05am" */
	until: string;
	/** The three lines the owner wrote, in trip order, newline separated. */
	block: string;
	/** How many whole days the stopover is worth. */
	fullDayCount: number;
}

function minutesIntoDay(localIso: string): number {
	const match = /T(\d{2}):(\d{2})/.exec(localIso);
	if (match === null) return Number.NaN;
	return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether one calendar day of the window is a day the traveller actually gets.
 *
 * A piece that runs midnight to midnight always is. The first piece also does when it
 * runs to midnight and started before 5am, which is the owner's landing rule: a red-eye
 * that puts you in bed at 2:15am has not cost you the Saturday.
 */
function isFullDay(piece: FreeTimePiece, index: number): boolean {
	if (piece.wholeDay) return true;
	return (
		index === 0 && piece.endsAtMidnight && minutesIntoDay(piece.start) < FULL_DAY_ARRIVAL_CUTOFF_MINUTES
	);
}

function countPhrase(fullDayCount: number): string {
	if (fullDayCount === 0) return 'No full days';
	return fullDayCount === 1 ? '1 full day' : `${fullDayCount} full days`;
}

/**
 * The block for one stopover, or `undefined` when there is no free time to describe at
 * all: a same-day connection with the window closed by waiting and transfers, which is a
 * fact about the schedule rather than something to print three empty lines about.
 */
export function freeTimeDays(start: LocalDateTime, end: LocalDateTime): FreeTimeDays | undefined {
	const pieces = splitFreeTimeAtLocalMidnight(start, end);
	if (pieces.length === 0) return undefined;

	// Every reading stays on the stopover airport's own clock, which is where both edges
	// already are. Rebuilding a day from its date and the window's zone keeps it there.
	const dayAt = (date: string): LocalDateTime => ({
		local: `${date}T00:00:00`,
		timeZone: start.timeZone,
		utcOffsetMinutes: start.utcOffsetMinutes
	});

	const fullDayDates = pieces.filter(isFullDay).map((piece) => piece.date);
	const count = countPhrase(fullDayDates.length);

	let fullDays: string;
	if (fullDayDates.length === 0) {
		fullDays = count;
	} else if (fullDayDates.length <= MAX_LISTED_FULL_DAYS) {
		fullDays = `${count}: ${fullDayDates.map((date) => formatWeekday(dayAt(date))).join(', ')}`;
	} else {
		const first = formatWeekdayAndDay(dayAt(fullDayDates[0]!));
		const last = formatWeekdayAndDay(dayAt(fullDayDates[fullDayDates.length - 1]!));
		fullDays = `${count}: ${first} to ${last}`;
	}

	const from = `${formatWeekdayAndDay(start)} from ${formatClockTime(start)}`;
	const until = `${formatWeekdayAndDay(end)} until ${formatClockTime(end)}`;

	return { from, count, fullDays, until, block: `${from}\n${fullDays}\n${until}`, fullDayCount: fullDayDates.length };
}
