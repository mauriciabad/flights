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

/**
 * What counts as a usable part of an edge day. Issue #306.
 *
 * The owner asked for "2+ days" when "the morning or afternoon can be used on the edge
 * days" and "2++ days" when both can. Neither `+` means anything until "can be used" is a
 * number, and the number has to be about the clock rather than the duration: a window that
 * ends at 6:05am is five hours of free time and no morning at all, and a `+` for it would
 * be the app claiming a day it has not got.
 *
 * So a part-day is usable when at least `USABLE_PART_DAY_MINUTES` of it falls between
 * `DAYTIME_START_MINUTES` and `DAYTIME_END_MINUTES`. Three hours of the 8am-to-6pm window,
 * which is what the two edges are actually worth to somebody walking around a city they
 * have never been to.
 *
 * Worked against the readings this app prints. An edge ending 6:05am overlaps the window by
 * nothing and gets no `+`, which is the case the issue names. Landing at 9:10pm, the
 * owner's own #228 example, likewise. An edge ending 1:15pm gives 5h15m and does get one.
 * Landing at 3pm gives exactly three hours and gets one; landing at 4pm gives two and does
 * not, because an afternoon that starts at 4pm is an evening.
 *
 * One threshold, applied identically to both edges, so the suffix cannot mean two things
 * depending on which end of the trip it came from.
 */
const DAYTIME_START_MINUTES = 8 * 60;
const DAYTIME_END_MINUTES = 18 * 60;
const USABLE_PART_DAY_MINUTES = 3 * 60;

/** Past a week the weekday names repeat, and "Mon, Tue, Wed, Thu, Fri, Sat, Sun, Mon" no
 * longer names a day. A span does. */
const MAX_LISTED_FULL_DAYS = 7;

export interface FreeTimeDays {
	/** "Fri 9 from 9:10pm" */
	from: string;
	/**
	 * "2 days" | "2+ days" | "2++ days" | "Part of a day" | "No full days", for a cell with
	 * one line to give. Issue #306: the suffix says how many of the two edge days carry a
	 * usable morning or afternoon, and `usablePartDays` below is the same fact as a number.
	 */
	count: string;
	/** What the suffix on `count` is claiming, in words, or absent when it claims nothing.
	 * The card has room for "2+ days" and not for a sentence, so the sentence goes wherever
	 * the stopover is described in full. */
	countMeaning?: string;
	/** "2 full days: Sat, Sun" | "No full days" */
	fullDays: string;
	/** "Mon 12 until 9:05am" */
	until: string;
	/** The three lines the owner wrote, in trip order, newline separated. */
	block: string;
	/** How many whole days the stopover is worth. */
	fullDayCount: number;
	/** How many of the two edge days carry a usable morning or afternoon: 0, 1 or 2. */
	usablePartDayCount: number;
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

/** Minutes of this piece that fall inside the daytime window. */
function usableMinutes(piece: FreeTimePiece): number {
	const from = Math.max(minutesIntoDay(piece.start), DAYTIME_START_MINUTES);
	// A piece that runs to midnight ends at 1440 in its own day's minutes, which
	// `minutesIntoDay` reads off the next date's `00:00` as 0. The flag is what tells the
	// two apart, and reading it wrong would call every arrival evening a full afternoon.
	const to = Math.min(piece.endsAtMidnight ? 24 * 60 : minutesIntoDay(piece.end), DAYTIME_END_MINUTES);
	return Math.max(0, to - from);
}

function isUsablePartDay(piece: FreeTimePiece): boolean {
	return usableMinutes(piece) >= USABLE_PART_DAY_MINUTES;
}

/**
 * The label for a stopover's day count, with issue #306's suffix.
 *
 * Zero whole days does not take a suffix, because "0+ days" reads as a bug rather than as
 * an answer, which is the same objection the owner made to "0 full days" on #228. What it
 * has instead is a noun that says what is really there: a stopover with no whole day but a
 * usable afternoon is a part of a day, and one with a usable afternoon and a usable morning
 * on either side of a night is parts of two.
 */
function dayCountLabel(fullDayCount: number, usablePartDayCount: number): string {
	if (fullDayCount === 0) {
		if (usablePartDayCount === 0) return 'No full days';
		return usablePartDayCount === 1 ? 'Part of a day' : 'Parts of 2 days';
	}
	// Singular only when the claim really is one day. "1+ day" is ungrammatical: the suffix
	// says there is more than a day here, so the noun has to agree with the whole figure
	// rather than with the digit in front of it.
	const noun = fullDayCount === 1 && usablePartDayCount === 0 ? 'day' : 'days';
	return `${fullDayCount}${'+'.repeat(usablePartDayCount)} ${noun}`;
}

/** What the `+` is claiming, named per edge so a reader can check it against the two clock
 * readings printed above it. */
function meaningOf(usableArrival: boolean, usableDeparture: boolean): string | undefined {
	const arrival = 'a usable afternoon on the day you arrive';
	const departure = 'a usable morning on the day you leave';
	if (usableArrival && usableDeparture) return `Plus ${arrival} and ${departure}`;
	if (usableArrival) return `Plus ${arrival}`;
	if (usableDeparture) return `Plus ${departure}`;
	return undefined;
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

	// Issue #306. The two edges are the first and last pieces, and only when they are not
	// already whole days: a red-eye that lands at 2:15am makes its arrival day full under
	// #228's own rule, and counting it a second time as a usable afternoon would print
	// "3+ days" for three days.
	const first = pieces[0]!;
	const last = pieces[pieces.length - 1]!;
	const usableArrival = !isFullDay(first, 0) && isUsablePartDay(first);
	const usableDeparture = last !== first && !isFullDay(last, pieces.length - 1) && isUsablePartDay(last);
	const usablePartDayCount = Number(usableArrival) + Number(usableDeparture);

	const count = dayCountLabel(fullDayDates.length, usablePartDayCount);
	const listedCount = countPhrase(fullDayDates.length);

	// The middle line keeps #228's own wording, "2 full days: Sat, Sun". It names the whole
	// days it can list, so the suffix has no business in it: the edges are the two readings
	// printed on either side of this line, and `countMeaning` is what says so in words.
	let fullDays: string;
	if (fullDayDates.length === 0) {
		fullDays = listedCount;
	} else if (fullDayDates.length <= MAX_LISTED_FULL_DAYS) {
		fullDays = `${listedCount}: ${fullDayDates.map((date) => formatWeekday(dayAt(date))).join(', ')}`;
	} else {
		const firstDay = formatWeekdayAndDay(dayAt(fullDayDates[0]!));
		const lastDay = formatWeekdayAndDay(dayAt(fullDayDates[fullDayDates.length - 1]!));
		fullDays = `${listedCount}: ${firstDay} to ${lastDay}`;
	}

	const from = `${formatWeekdayAndDay(start)} from ${formatClockTime(start)}`;
	const until = `${formatWeekdayAndDay(end)} until ${formatClockTime(end)}`;

	return {
		from,
		count,
		countMeaning: meaningOf(usableArrival, usableDeparture),
		fullDays,
		until,
		block: `${from}\n${fullDays}\n${until}`,
		fullDayCount: fullDayDates.length,
		usablePartDayCount
	};
}
