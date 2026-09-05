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

import type { Transfer, TransferAnchor, TransferLeg, TransferMode } from '../domain';
import type { WithheldRoutes } from '../search/types';
import { formatDuration } from '$lib/format';

export {
	calendarDayOffset,
	formatCalendarDate,
	formatClockTime,
	formatDuration,
	formatLongDuration,
	formatMoney,
	formatMoneyDelta,
	formatMoneyRange,
	formatPropertyRating,
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

/** Past this many rides, naming each one is longer than counting them. Four vehicles
 * spelled out is "Bus, then train, then coach, then bus", which no longer fits a row and
 * stopped being a summary somewhere around the second "then". */
const MAX_NAMED_VEHICLES = 3;

/**
 * One line for a whole journey: what you ride, in order, and how many times you change.
 *
 * Issue #220, the owner's own words: **"the transport item in timeline has a brick of
 * unformated text that is impossible to understand."** The row printed every leg's full
 * description joined by commas, so a four-leg trip read "Walk (0 m), Transit OLB-BHX to
 * Aeroporto di Olbia (OLB) (JET TWO COM), Walk (0 m), Transit OLB-FCO to ..." and ran off
 * the row. Even a correct journey is unreadable that way.
 *
 * What is dropped, and why it is safe to drop it here: the walks between rides, the line
 * numbers, the operators and the times. All of them are still one tap away in the picker's
 * step list, which is where somebody who has decided to take this route reads them. A
 * summary that keeps everything is the brick again.
 *
 * `undefined` when there is nothing to summarise, and the caller then falls back to the
 * mode label, which is the whole truth in every one of those cases:
 *
 * - A transfer with no legs at all. Every OSRM answer is one.
 * - A journey that is only walking.
 * - A taxi or a drive, whose leg this deliberately does not count as a ride. "Taxi" says
 *   more than "1 ride" does, and a car has nothing to change between.
 */
export function summariseTransferLegs(legs: readonly TransferLeg[]): string | undefined {
	const rides = legs.filter((leg) => leg.mode === 'transit');
	if (rides.length === 0) return undefined;

	const changes = rides.length - 1;
	const suffix = changes === 0 ? '' : changes === 1 ? ' (1 change)' : ` (${changes} changes)`;

	// A `Transfer` cached before this field existed has no `vehicle` on any leg, and so does
	// any future adapter that does not name its vehicles. Counting them is still a real
	// answer, and a better one than printing "undefined, then undefined".
	const vehicles = rides.map((ride) => ride.vehicle).filter((vehicle): vehicle is string => Boolean(vehicle));
	if (vehicles.length !== rides.length || rides.length > MAX_NAMED_VEHICLES) {
		return `${rides.length} ${rides.length === 1 ? 'ride' : 'rides'}${suffix}`;
	}

	// Sentence case, so the line reads as a sentence fragment rather than as three proper
	// nouns: "Metro, then bus, then coach".
	const named = vehicles.map((vehicle, index) => (index === 0 ? vehicle : vehicle.toLocaleLowerCase()));
	return `${named.join(', then ')}${suffix}`;
}

/** What a transfer row's one-line detail says: the vehicles when a provider named them,
 * and the mode on its own when it did not. "Bus, then metro (1 change)" tells a traveller
 * more than "Public transport" does, and for a walk or a taxi the mode already is the
 * whole answer. */
export function transferDetailLine(transfer: Transfer): string {
	return summariseTransferLegs(transfer.legs) ?? transferModeLabel(transfer.mode);
}

/**
 * A distance, for the sentences that have to justify a refusal: `TransportPicker`'s
 * withheld-route notice (issue #220, a straight line) and its withheld-fare notice (issue
 * #246, a road distance). Whole kilometres above 1 km, one decimal below it, and a
 * non-breaking space so "9 km" cannot wrap in half. It was `formatStraightLineKm` until the
 * second caller arrived with a road distance and made that name a lie; which kind of
 * distance it is belongs in the sentence, not in the formatter.
 */
export function formatKilometres(km: number): string {
	const rounded = km < 1 ? Math.round(km * 10) / 10 : Math.round(km);
	return `${rounded}\u00a0km`;
}

/**
 * What a transfer row prints where a price would go, when no provider quoted one.
 *
 * Issue #119, the owner on a walking option: **"and price of walk is 0€..."**. That zero
 * is long gone from this codebase — no `TransferProvider` sets `Transfer.price` at all, so
 * every row already fell through to a "not available" note — but the note itself still put
 * walking and a bus in the same bucket. They are not the same fact. Walking has no fare:
 * that is something this app knows, and it is the reason walking is worth offering. A bus
 * with no price is a gap in what Transitous told us. Printing one sentence for both makes
 * the known fact look like the missing one, which is the same collapse the €0 made in the
 * other direction.
 *
 * `compact` is the timeline's own price column, which sits under real money on a 375px
 * screen and cannot take a full sentence. The picker gives the note a row to itself.
 */
export function unpricedTransferNote(mode: TransferMode, compact = false): string {
	if (mode === 'walk') return compact ? 'no fare' : 'No fare';
	return compact ? 'price n/a' : 'Price not available';
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
 * - Zero nights is a same-day connection, or since issue #231 an overnight wait too short
 *   to sleep through. Either way there is no hotel leg to price and the row is not waiting
 *   on one, and `overnightWait` picks which of the two it says. The row still renders: `ItineraryTimeline` prints every schedule
 *   step in a fixed order, so a row that vanishes for one itinerary and not another makes
 *   two trips harder to read against each other. Saying why it is empty is the fix,
 *   deleting it is not.
 * - Nights but no priced stay used to mean there was no address at either end, so nothing
 *   was looked up. Issue #161 gave these two legs a second possible destination — the
 *   connection city's own centre, routed whenever `data/airport-city-names.ts` has a
 *   hand-checked point for it — so reaching this function with no stay now means neither
 *   destination was available, and the sentence says both halves rather than blaming the
 *   bed alone.
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
	context: {
		hasStay: boolean;
		nightsInConnection: number;
		overnightWait?: boolean;
		/** `Itinerary.transferAnchor`, which is the only one of these that can say a route
		 * was never asked for rather than asked for and refused (issue #243). */
		transferAnchor?: TransferAnchor;
		/**
		 * Issue #119: what this leg's road rule refused, when it refused anything. Every
		 * sentence below claims nothing was routed, and this is the one case where that is
		 * false — a router answered, at 33 hours to cover 157 km, and this app is what
		 * decided the traveller should not be offered it. Same reasoning as #220's withheld
		 * notice in `TransportPicker`, in the place a refused DRIVE actually lands: that
		 * rule usually empties the leg outright, so there is no picker left to say it in.
		 *
		 * Ranked BELOW `transferAnchor` on purpose — see the `unrouted-stay` branch.
		 */
		withheldRoad?: WithheldRoutes;
	}
): string {
	if (leg === 'to-hotel' || leg === 'from-hotel') {
		// Issue #243: the traveller picked a property off the stay list, and the search
		// routes to the one property it picks itself and no other, so nothing has ever been
		// asked about this address. Distinct from the last sentence in this branch, which
		// would blame a transport provider for refusing a question nobody put to it.
		//
		// First, and that matters more than it looks. `withheldRoad` below describes the leg
		// the SEARCH routed, to the property the search picked. Once the traveller has moved
		// to a different one, that refusal is about an address they are no longer looking at,
		// and printing "the road route in takes 33h" beside this property's name would be
		// #243's own wrong-address bug arriving from the other direction. Reorder these two
		// and `itinerary-timeline-format.test.ts` fails on purpose.
		if (context.transferAnchor === 'unrouted-stay') {
			return leg === 'to-hotel'
				? 'Nothing routed to this property, so the journey to it is unknown.'
				: 'Nothing routed back from this property, so the journey back is unknown.';
		}
		if (!context.hasStay && context.nightsInConnection === 0) {
			// Issue #231 split the nightless trip in two. Both book nothing, but one of them
			// is awake in a terminal at 3am, and telling that traveller their connection is
			// same-day is the app describing a different journey from the one they are on.
			return context.overnightWait
				? 'Overnight wait, so there is no hotel leg here.'
				: 'Same-day connection, so there is no hotel leg here.';
		}
		// Above the two "nothing routed" sentences below, and above #211's, because it
		// contradicts all three. "Nothing routed into the city" is as false as "no transport
		// provider could route to it" when a router answered at 33 hours and this app refused
		// the answer. Below the nightless branch, though: that traveller is not going to a
		// bed at all, and the refusal is true and irrelevant to them.
		if (context.withheldRoad) return withheldRoadNote(leg, context.withheldRoad);
		if (!context.hasStay) {
			// Issue #185: the row's own fact and nothing else. It used to open with "No bed
			// priced for this stopover", which was true but was also the third and sixth of
			// seven places on one screen saying it — and the reason now lives once, in the
			// stopover row's own fold (`stays/no-stays-reason.ts`).
			//
			// #185 asked for this wording to be left alone, on the grounds that #161 would
			// stop these rows appearing at all by routing to the city centre instead. #161
			// landed and they still appeared, because the centre point came from #162's
			// hand-checked dataset of ten airports, which did not cover LGW. Issue #198
			// then generated a centre for about three quarters of the dataset, LGW among
			// them, so the acceptance trip routes now. This sentence is still reached, and
			// still has to be right: a quarter of airports have no centre at all, and a
			// routing provider can fail for one that does.
			return leg === 'to-hotel'
				? 'Nothing routed into the city for this stopover.'
				: 'Nothing routed back from the city for this stopover.';
		}
		// Issue #211: a bed WAS priced and no transfer provider could route to it. Until
		// that issue this state could not occur, because `search/resources.ts` deleted the
		// bed instead and the row above claimed nothing had ever been priced. Naming the bed
		// is the whole point: the traveller can see its price on the same card, so a row
		// that only said "no route" would read as being about some other place.
		return leg === 'to-hotel'
			? 'The bed is priced, but no transport provider could route to it.'
			: 'The bed is priced, but no transport provider could route back from it.';
	}
	if (context.withheldRoad) return withheldRoadNote(leg, context.withheldRoad);
	return 'No route came back from the transport providers for this leg.';
}

/**
 * The refusal, in the two numbers it was made on. Deliberately does not print
 * `WithheldRoutes.count`: driving and taxi are one OSRM route wearing two labels
 * (`providers/transfers/osrm.ts`), so the count here is almost always 2 and "2 routes"
 * would describe two options where the traveller has one.
 */
function withheldRoadNote(leg: UnroutedLeg, withheld: WithheldRoutes): string {
	const subject =
		leg === 'to-hotel'
			? 'The road route in'
			: leg === 'from-hotel'
				? 'The road route back'
				: 'The road route';
	return `${subject} takes ${formatDuration(withheld.quickest)} to cover ${formatKilometres(withheld.straightLineKm)} in a straight line, so it is not offered.`;
}
