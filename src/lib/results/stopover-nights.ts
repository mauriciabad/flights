/**
 * Issue #224: the words the nights control puts on a card, kept out of the component so
 * they are testable without mounting Svelte, the same split `view-model.ts` already makes.
 *
 * Three things have to be said, and the issue and its sibling #225 are explicit about all
 * three:
 *
 * - A trip of zero nights is not a short stopover. The traveller lands and leaves on the
 *   same calendar day and there is no bed to book. The owner's own word for it is a flight
 *   change, and `stopoverLengthLabel` uses it rather than printing "0 nights".
 * - "Do not silently cap it either. If the traveller extends beyond what the flight pairing
 *   supports, the onward flight has to change, and the card must say the price moved and
 *   why." The ladder is that answer, and a fuller one than the single sentence it replaced:
 *   it marks the trip on screen, prices every other length against it, and
 *   `describeLadderFlights` names which flight has to move for any of them to happen.
 * - "then we simply show +x€per night" (#225). `stopoverLadder` is that figure, once per
 *   length the city can do, and every one of them is computed from two real pairings
 *   rather than from the bed's nightly rate. A longer stay usually means a different
 *   onward fare, and quoting EUR 13 for a night that the fare change actually makes EUR 3
 *   CHEAPER would be an invented number on a card whose whole job is to be trusted. That
 *   is not hypothetical: measured on the owner's own route, London's second night comes to
 *   minus three euros.
 */

import { waitsOvernight } from '$lib/algorithm/nights';
import { isSameFlight } from '$lib/algorithm/pairings';
import type { Itinerary } from '$lib/domain';
import { formatDuration, formatMoneyDelta } from '$lib/format';

/** "Flight change", "1 night", "3 nights". The one string the control's value and every
 * label built from it read, so they can never disagree about what zero means.
 *
 * Zero has meant two different trips since issue #231, and this function can only see the
 * number. Prefer `stopoverLengthLabelFor` wherever the itinerary itself is to hand. */
export function stopoverLengthLabel(nights: number): string {
	if (nights <= 0) return 'Flight change';
	return `${nights} ${nights === 1 ? 'night' : 'nights'}`;
}

/**
 * The same length, counted rather than named, for the ladder of lengths a traveller picks
 * from.
 *
 * Issue #318: six rungs read "1 night" to "6 nights" and the seventh read "Flight change",
 * which is the only one not counting nights and which collides with the booking sense of
 * the phrase. A ladder is a series, and the rung that means "do not stay" is 0 nights.
 *
 * `stopoverLengthLabelFor` still names the trip everywhere the card describes one, because
 * issue #231's distinction between a flight change and an overnight wait is about what kind
 * of trip this is, not about how long the traveller asked to stay. The ladder keeps it in
 * the rung's spoken description instead.
 */
export function stopoverLadderLengthLabel(nights: number): string {
	return `${nights} ${nights === 1 ? 'night' : 'nights'}`;
}

/**
 * The same label, told apart by which kind of nightless trip this is.
 *
 * Issue #231 split zero in two. A same-day connection lands and leaves before midnight and
 * is a flight change. A gap from 11pm to 5am also books no bed, but calling that a flight
 * change would say the traveller sleeps at home: they are awake in a terminal at 3am, and
 * the card has to be able to say so. Both totals are the flights alone; only one of them
 * costs a night's sleep.
 */
export function stopoverLengthLabelFor(itinerary: Itinerary): string {
	if (itinerary.nightsInConnection > 0) return stopoverLengthLabel(itinerary.nightsInConnection);
	return waitsOvernight(itinerary) ? 'Overnight wait' : 'Flight change';
}

/**
 * What the overnight wait actually is, for the one place with room to say it: how long the
 * traveller is on the ground and why no bed is priced for it. `undefined` for every trip
 * that is not one, so a caller can render this or nothing without asking twice.
 */
export function overnightWaitNote(itinerary: Itinerary): string | undefined {
	if (itinerary.nightsInConnection > 0) return undefined;
	if (!waitsOvernight(itinerary)) return undefined;
	return `Overnight wait, ${formatDuration(itinerary.freeTime.duration)}, too short to be worth a bed`;
}

/** Which flights a longer stopover had to reach for. Both change when a city's next
 * length up comes from a different day's outbound as well as a later onward. */
export type ChangedFlights = 'none' | 'outbound' | 'onward' | 'both';

/** Issue #387 moved this comparison to `algorithm/pairings.ts`, where the pairing search
 * needs the same answer. Its doc comment carries the reason it is not `===`, which was
 * found here: Svelte deep-proxies `$state`, so one offer read through two paths is two
 * objects, and reference equality printed "Same price, on different flights both ways"
 * under every card on production. */
function flightsChanged(shown: Itinerary, minimum: Itinerary): ChangedFlights {
	const outbound = !isSameFlight(shown.outboundFlight, minimum.outboundFlight);
	const onward = !isSameFlight(shown.onwardFlight, minimum.onwardFlight);
	if (outbound && onward) return 'both';
	if (outbound) return 'outbound';
	if (onward) return 'onward';
	return 'none';
}

/** One rung of a connection's ladder, ready to render as a button. */
export interface StopoverLengthChoice {
	nights: number;
	/** "Flight change", "1 night", "3 nights". */
	label: string;
	/** This length's total minus the total of the trip on screen, in minor units of their
	 * shared currency. Signed, and zero on the rung the card is showing. */
	deltaMinorUnits: number;
	currency: string;
	/** "+€24.00", "-€3.00", "same price", or `undefined` on the rung the card is showing,
	 * where the headline above already prints the whole number. */
	delta?: string;
	isCurrent: boolean;
	/** The button's accessible name: the trip it would produce and what it costs. Never a
	 * verb. "Longer" tells a screen-reader user which way the button points and nothing
	 * about where it lands, and where it lands is a different flight at a different fare. */
	description: string;
}

/** The shape `ScoredResult.stopover.options` already has, taken structurally so this
 * module never imports the results layer that imports it. */
interface LengthOption {
	nights: number;
	itinerary: Itinerary;
}

/**
 * Every stopover length this connection can do, each priced against the trip on screen.
 *
 * Issue #225, the owner's own sketch:
 *
 * ```
 * STAYING LONGER
 *   [+] 1 more night   -€3.00
 *   [+] 2 more nights  +€24.00
 *   (different onward flight each time)
 * ```
 *
 * The deltas are measured against the trip whose total is printed above them, not against
 * the shortest, so the headline plus a rung's delta is exactly what that rung costs. At a
 * card's default those are the same thing, because the card opens on the shortest pairing
 * (#230). They stop being the same the moment somebody extends, and an anchor to the
 * shortest would then print figures that add up to no number on screen.
 *
 * Every delta comes from two real pairings' real totals. There is deliberately no "+EUR x
 * per night" anywhere here: a pairing's nights are fixed by its two flights, so a longer
 * stay is a DIFFERENT pairing on a different onward fare, and the bed's nightly rate is
 * only one part of what changes. Measured on the owner's own route, London's second night
 * comes to minus three euros, where a nightly-rate model would have said plus thirteen.
 *
 * `options` arrives ascending from `stopoverLengths` and is never re-sorted here.
 */
export function stopoverLadder(
	shown: Itinerary,
	options: readonly LengthOption[],
	connectionLabel: string
): StopoverLengthChoice[] {
	return options.map((option) => {
		const isCurrent = option.nights === shown.nightsInConnection;
		const deltaMinorUnits = option.itinerary.totalPrice.minorUnits - shown.totalPrice.minorUnits;
		const currency = option.itinerary.totalPrice.currency;
		// Issue #318: the rung counts nights, so the series reads 0, 1, 2 rather than breaking
		// on the one option that matters most. Issue #231's reading of a nightless trip is not
		// lost: it goes into the spoken description below, after the visible words, which is
		// the order WCAG 2.5.3 asks for.
		const label = stopoverLadderLengthLabel(option.nights);
		const kind =
			option.nights === 0 ? `, ${stopoverLengthLabelFor(option.itinerary).toLowerCase()}` : '';
		const delta = isCurrent ? undefined : formatMoneyDelta(deltaMinorUnits, currency);
		return {
			nights: option.nights,
			label,
			deltaMinorUnits,
			currency,
			...(delta === undefined ? {} : { delta }),
			isCurrent,
			description: isCurrent
				? `${label} in ${connectionLabel}${kind}, the trip shown`
				: `${label} in ${connectionLabel}${kind}, ${delta}`
		};
	});
}

/**
 * The owner's "(different onward flight each time)", said only when it is true and only
 * about the flights that actually move.
 *
 * Which half of the pairing moved is the fact a traveller needs before they trust a delta:
 * a later onward flight is a fare change, a different outbound is a different departure
 * day. Derived by comparing every other rung against the trip on screen rather than
 * asserted, because a city whose lengths all share one outbound really does only move the
 * onward leg, and saying "flights" there would overstate what changes.
 *
 * `undefined` when nothing moves, which leaves a card at a single length with no note.
 */
export function describeLadderFlights(
	shown: Itinerary,
	options: readonly LengthOption[]
): string | undefined {
	const others = options.filter((option) => option.nights !== shown.nightsInConnection);
	if (others.length === 0) return undefined;

	let outboundMoves = false;
	let onwardMoves = false;
	for (const other of others) {
		const changed = flightsChanged(other.itinerary, shown);
		if (changed === 'outbound' || changed === 'both') outboundMoves = true;
		if (changed === 'onward' || changed === 'both') onwardMoves = true;
	}
	if (!outboundMoves && !onwardMoves) return undefined;

	const what = outboundMoves ? 'different flights' : 'a different onward flight';
	// "each time" with one alternative names a repetition that does not happen.
	return others.length === 1 ? what : `${what} each time`;
}

