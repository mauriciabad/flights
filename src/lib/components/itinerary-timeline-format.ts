/**
 * Display formatting for the departure-board components: ItineraryTimeline (issue #24),
 * FlightPicker and TransportPicker (issue #28), and the comparator (issue #25).
 *
 * The generic formatters this module used to define now live in `$lib/format`, the one
 * place a domain value becomes a string, and are re-exported below so every existing
 * import path still resolves. See that file's header for what the merge changed and why.
 * What stays here is the part that is genuinely about *this* app's timeline rows rather
 * than about money or clocks: how a transfer mode is spelled, and what a row says when
 * the providers came back with no route for it.
 */

import type { TransferMode } from '../domain';

export {
	calendarDayOffset,
	formatCalendarDate,
	formatClockTime,
	formatDuration,
	formatLongDuration,
	formatMoney,
	formatMoneyDelta,
	formatMoneyRange,
	formatTimeDelta,
	formatUtcOffset,
	isDifferentCalendarDate
} from '$lib/format';

const TRANSFER_MODE_LABELS: Record<TransferMode, string> = {
	walk: 'Walk',
	transit: 'Public transport',
	taxi: 'Taxi',
	drive: 'Drive'
};

/** "Walk", "Public transport", "Taxi", "Drive": brief line 77's four transfer modes,
 * spelled out for a traveller rather than shown as the raw domain literal. */
export function transferModeLabel(mode: TransferMode): string {
	return TRANSFER_MODE_LABELS[mode];
}

/**
 * Which unrouted leg a timeline row is describing. The two connection-side legs are named
 * separately because they are the same missing hotel seen from opposite ends, and a row
 * that reads "nowhere to travel to" above the stopover and "nowhere to travel back from"
 * below it tells a traveller what they are actually looking at.
 */
export type UnroutedLeg =
	| 'to-hotel'
	| 'from-hotel'
	| 'to-origin-airport'
	| 'to-destination-location';

/**
 * Issue #140: what a transfer row says when it has no transfer.
 *
 * It used to say "Transfer details not available yet." on every one of them. On a default
 * first-run search that is false twice over: nothing is coming, and nothing was ever
 * requested. `search/resources.ts` fetches the two connection-side transfers only after a
 * stay has been priced (`if (!stay) return withoutStay(...)`), so with no Agoda or
 * Booking.com key the pipeline makes zero Transitous and zero OSRM calls for them. "Yet"
 * described a future that does not exist, which is the waiting-state form of AGENTS.md's
 * "show the error you got, never the one you assumed".
 *
 * Each sentence below is a fact about this itinerary, readable straight off it:
 *
 * - Zero nights is a same-day connection. There is no hotel leg to price and the row is
 *   not waiting on one. The row still renders: `ItineraryTimeline` prints every schedule
 *   step in a fixed order, so a row that vanishes for one itinerary and not another makes
 *   two trips harder to read against each other. Saying why it is empty is the fix,
 *   deleting it is not.
 * - Nights but no priced stay means there is no address at either end, so nothing was
 *   looked up.
 * - The outer legs are gated on the query carrying an origin or destination location
 *   instead, and their rows only render when it does. Reaching this function there means
 *   the providers were asked and came back with nothing.
 *
 * Deliberately no "add a key" advice: the stopover row sitting directly between these two
 * already carries it once, and repeating it per row is what issue #117 flagged as reading
 * like an error rather than a setup step.
 */
export function unroutedLegNote(
	leg: UnroutedLeg,
	context: { hasStay: boolean; nightsInConnection: number }
): string {
	if (leg === 'to-hotel' || leg === 'from-hotel') {
		if (!context.hasStay && context.nightsInConnection === 0) {
			return 'Same-day connection, so there is no hotel leg here.';
		}
		if (!context.hasStay) {
			return leg === 'to-hotel'
				? 'No bed priced for this stopover, so there is nowhere to travel to.'
				: 'No bed priced for this stopover, so there is nowhere to travel back from.';
		}
	}
	return 'No route came back from the transport providers for this leg.';
}
