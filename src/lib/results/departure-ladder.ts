/**
 * Issue #387: the words the departure-date control puts on a panel, kept out of the
 * component so they are testable without mounting Svelte, the same split
 * `stopover-nights.ts` already makes for the nights ladder.
 *
 * The owner named the model to copy himself:
 *
 * > now I can easily change the duration of the free time, that is well done. but changing
 * > the departure date is not easy
 *
 * So this is `stopoverLadder` on the other axis, and it is deliberately the same shape: one
 * rung per date the stopover can leave on, each priced against the trip on screen, the
 * current one marked in words as well as in colour. Every delta is two real pairings'
 * totals subtracted, never a per-day rate, for the same reason the nights ladder refuses
 * one: a different departure date is a different pairing on a different fare, and often a
 * different hotel bill too.
 */

import { departureDateOf, isSameFlight } from '$lib/algorithm/pairings';
import type { Itinerary } from '$lib/domain';
import { formatMoney, formatMoneyDelta, formatWeekdayAndDay } from '$lib/format';

/** One rung of a connection's departure ladder: a date it can leave on, and the trip that
 * leaves then. Carried rather than only the date so a rung prices itself before it is
 * pressed, exactly as `StopoverLengthOption` does. */
export interface DepartureDateOption {
	/** `YYYY-MM-DD` in the origin airport's own calendar. */
	date: string;
	itinerary: Itinerary;
}

/** One rung, ready to render as a button. */
export interface DepartureDateChoice {
	date: string;
	/** "Wed 16". A search window is days rather than months, so weekday and day number
	 * identify a rung on their own and a month would be the same word on every one. */
	label: string;
	/** This date's total minus the total of the trip on screen, in minor units of their
	 * shared currency. Signed, and zero on the rung the panel is showing. */
	deltaMinorUnits: number;
	currency: string;
	/** "+€24.00", "-€3.00", "same price", or `undefined` on the rung being shown. */
	delta?: string;
	isCurrent: boolean;
	/** The cheapest rung on the ladder. The owner asked twice in one sentence for the
	 * options "shorted by best price"; this is that answer without taking the dates out of
	 * calendar order. Never set when it is also the current rung, where "this trip" already
	 * occupies the line and the price above it is the whole number. */
	isCheapest: boolean;
	/** The button's accessible name: the day it lands on and what it costs. */
	description: string;
}

/**
 * How many rungs the row draws at most, and why it is seven.
 *
 * Kayak's own flexible-date window is the chosen date plus or minus three, which is seven.
 * Baymard's truncation research puts the useful band for a list like this at six to ten, and
 * NN/g's date-list guidance caps at ten. Seven sits inside both and, at the stub width the
 * nights ladder already uses, wraps to two rows on a 375px phone rather than six.
 *
 * The cap is real rather than defensive. A search window is whatever the traveller typed:
 * `dep=2026-09-01&arr=2026-09-30` is a perfectly ordinary URL and would otherwise draw
 * twenty-odd stubs down a 300px rail.
 */
export const MAX_DEPARTURE_RUNGS = 7;

/**
 * Every date this connection can leave on, each priced against the trip on screen.
 *
 * ## Calendar order, with the cheapest marked, rather than sorted by price
 *
 * The owner asked for the options "shorted by best price", twice in one sentence, and this
 * row is in calendar order. That is a deliberate answer to what he wants rather than to
 * what he typed, and it is worth writing down why.
 *
 * A date is a point on a calendar before it is a price. Shuffling "Thu 17, Wed 16, Fri 18"
 * into price order turns the one question a date control exists to answer, which day is
 * this, into a scan of the whole row. It would also be least useful exactly where he is
 * standing: since issue #364 the card already opens on the cheapest pairing this city can
 * do, which is by construction on the cheapest date, so a price-sorted row would put the
 * current pick first and stay that way until he moved off it.
 *
 * What he actually asked to be able to do is see where the money is without arithmetic, and
 * every rung carries its own signed delta for that, with the cheapest one marked in words.
 * The nights ladder he called "well done" is ordered by nights and not by price for the same
 * reason, and he has already accepted that reading.
 *
 * `options` arrives ascending from `departureDates` and is never re-sorted here.
 */
export function departureLadder(
	shown: Itinerary,
	options: readonly DepartureDateOption[]
): DepartureDateChoice[] {
	const cheapest = cheapestDate(options);
	return rungsToDraw(shown, options).map((option) => {
		const isCurrent = option.date === departureDateOf(shown);
		const deltaMinorUnits = option.itinerary.totalPrice.minorUnits - shown.totalPrice.minorUnits;
		const currency = option.itinerary.totalPrice.currency;
		const label = formatWeekdayAndDay(option.itinerary.outboundFlight.departure);
		const delta = isCurrent ? undefined : formatMoneyDelta(deltaMinorUnits, currency);
		const isCheapest = !isCurrent && option.date === cheapest;
		return {
			date: option.date,
			label,
			deltaMinorUnits,
			currency,
			...(delta === undefined ? {} : { delta }),
			isCurrent,
			isCheapest,
			description: isCurrent
				? `Leave ${label}, the trip shown`
				: `Leave ${label}, ${spokenDelta(deltaMinorUnits, currency)}${
						isCheapest ? ', the cheapest day' : ''
					}`
		};
	});
}

/**
 * The delta again, for the ear rather than the eye, naming what it is measured against.
 *
 * "+EUR 24.80" on a button is unambiguous next to the headline it is anchored to and says
 * nothing on its own read out in a list of buttons. Kiwi.com ships this exact sentence for
 * this exact control: their price strip's own translated string is `"{price} cheaper than
 * currently selected date"`. Same fix, same reason.
 */
function spokenDelta(deltaMinorUnits: number, currency: string): string {
	if (deltaMinorUnits === 0) return 'the same price as the day shown';
	const amount = formatMoney({ minorUnits: Math.abs(deltaMinorUnits), currency });
	return deltaMinorUnits < 0
		? `${amount} cheaper than the day shown`
		: `${amount} more than the day shown`;
}

/**
 * Which days make the row when there are more than it can hold: the cheapest ones, plus
 * whichever day is on screen, shown in calendar order.
 *
 * This is where the owner's "shorted by best price" is honoured. Price decides WHICH days
 * appear and the calendar decides HOW they are arranged, which is the only reading that
 * satisfies both halves of what he asked for. A day left out is left out for being dearer
 * than seven others, and it is still reachable through the flight picker directly below,
 * which lists every flight on every date the search found.
 *
 * The day on screen is always kept, even when it is the dearest of the lot, because a row
 * that cannot show you where you are is not a control.
 */
function rungsToDraw(
	shown: Itinerary,
	options: readonly DepartureDateOption[]
): DepartureDateOption[] {
	if (options.length <= MAX_DEPARTURE_RUNGS) return [...options];
	const current = departureDateOf(shown);
	const byPrice = [...options].sort(
		(a, b) => a.itinerary.totalPrice.minorUnits - b.itinerary.totalPrice.minorUnits
	);
	const kept = new Set<string>();
	if (options.some((option) => option.date === current)) kept.add(current);
	for (const option of byPrice) {
		if (kept.size >= MAX_DEPARTURE_RUNGS) break;
		kept.add(option.date);
	}
	return options.filter((option) => kept.has(option.date));
}

/** The date with the lowest total. Ties go to the earliest, which `options` already
 * supplies by arriving in calendar order, so a strict comparison keeps it. `undefined` for
 * an empty ladder. */
function cheapestDate(options: readonly DepartureDateOption[]): string | undefined {
	let best: DepartureDateOption | undefined;
	for (const option of options) {
		if (!best || option.itinerary.totalPrice.minorUnits < best.itinerary.totalPrice.minorUnits) {
			best = option;
		}
	}
	return best?.date;
}

/**
 * What else moves when the departure date does, said only when it is true.
 *
 * A traveller about to press "Thu 17" is entitled to know, before pressing, that it is not
 * only the outbound flight that changes. Nearly every date change moves the onward flight
 * too, because the two flights together are what fix a stopover's length, and on this app
 * they usually move the hotel bill with them.
 *
 * Derived by comparing every other rung against the trip on screen rather than asserted,
 * the same way `describeLadderFlights` does for the nights ladder, so a connection whose
 * dates all share one onward flight does not claim a change it does not make.
 *
 * `undefined` when nothing else moves, which leaves a single-date panel with no note.
 */
export function describeDepartureLadder(
	shown: Itinerary,
	options: readonly DepartureDateOption[]
): string | undefined {
	const others = options.filter((option) => option.date !== departureDateOf(shown));
	if (others.length === 0) return undefined;

	const onwardMoves = others.some(
		(option) => !isSameFlight(option.itinerary.onwardFlight, shown.onwardFlight)
	);
	const nightsMove = others.some(
		(option) => option.itinerary.nightsInConnection !== shown.nightsInConnection
	);

	if (onwardMoves && nightsMove) return 'the onward flight and the nights move too';
	if (onwardMoves) return 'the onward flight moves too';
	if (nightsMove) return 'the nights move too';
	return undefined;
}
