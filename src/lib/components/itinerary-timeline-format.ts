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

import type {
	Duration,
	FareParty,
	FareRange,
	LocalDateTime,
	Transfer,
	TransferAnchor,
	TransferLeg,
	TransferMode,
	TransitPlanMoment
} from '../domain';
import { groundFare } from '../domain';
import { NORMAL_WAIT_THRESHOLD_MINUTES } from '../algorithm/transit-schedule';
import type { WithheldRoutes, WithheldTransfers } from '../search/types';
import { formatClockTime, formatDuration, formatMoney, formatMoneyRange } from '$lib/format';

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
	formatWeekdayAndDay,
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
 * Issue #290: the minutes between landing and starting to move, said out loud on any row
 * whose duration no longer contains them.
 *
 * `transferRideDuration` takes the walk-out back off the ride, which fixes the label and
 * loses a fact: the traveller still gets to the bed 1h 8m after the wheels touch, and the
 * clock at the end of the row still says so. This is the sentence that reconciles the two,
 * and it is why removing the buffer from the number is not the same as hiding it.
 *
 * "Your own" carries the weight. This is the one part of a ground leg the traveller set
 * themselves (`SearchQuery.landingToTransportRules`), and the airport-wait stub already
 * says the same thing about the other buffer in the same voice, "Your own buffer, not a
 * measured queue". Two traveller-set paddings described two different ways would be the
 * inconsistency this issue is about, arriving from the other side.
 *
 * `undefined` on a leg with no buffer, which includes a rule set to zero: there is nothing
 * to disclose when the ride and the row's duration are the same number, and a sentence
 * saying "plus your own 0m" is noise on every row that never starts at a runway.
 */
export function landingBufferNote(transfer: Transfer): string | undefined {
	if (!transfer.landingBuffer) return undefined;
	return (
		`Plus your own ${formatDuration(transfer.landingBuffer)} to get out of the airport, ` +
		`so you arrive ${formatDuration(transfer.duration)} after landing.`
	);
}

/**
 * The same buffer where a whole list of options shares it, which is `TransportPicker`.
 *
 * Its own sentence rather than `landingBufferNote` repeated per row, because the two say
 * different things. That one ends "so you arrive 1h 8m after landing", a total belonging to
 * one journey; a picker is showing four, and printing one row's total over all of them is
 * how this issue started. What every row here genuinely shares is the moment it starts.
 *
 * Worth saying at all because the buffer is the same on every candidate. Both pipelines
 * that apply it map over the whole list rather than the pick alone, so it is exactly the
 * part of these numbers that carries no information about which option to take.
 *
 * Takes the buffer rather than a transfer, so the caller has to reduce its own rows to one
 * number first and this sentence cannot claim "every option" about a list it never saw. A
 * list whose rows disagree passes `undefined` and the picker says nothing, which is the
 * right answer: the sentence's whole content is that the padding is shared.
 */
export function landingBufferPickerNote(buffer: Duration | undefined): string | undefined {
	if (!buffer) return undefined;
	return (
		`Every option here starts ${formatDuration(buffer)} after you land, which is ` +
		`your own landing-to-transport setting. The times below are the journeys themselves.`
	);
}

/**
 * The same fact where a panel has already spent its clocks on the ride: the segment stub,
 * whose start reading is the moment the vehicle leaves rather than the moment the plane
 * lands. The gap between those two is the whole of this sentence's job.
 *
 * Wording deliberately shared with the airport-wait stub's footnote, down to "not a
 * measured queue" and the pointer to where it is changed. A traveller who has read one of
 * them has read both. The pointer differs because the controls do: a waiting time is edited
 * on the row itself, and this one is a search field, so naming the row would send somebody
 * looking for a control that is not there.
 */
export function landingBufferFootnote(transfer: Transfer): string | undefined {
	if (!transfer.landingBuffer) return undefined;
	return (
		`Your own buffer, not a measured queue. ${formatDuration(transfer.landingBuffer)} is the ` +
		`Landing to transport setting for an airport this size, and the search form is where you change it.`
	);
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
 * What a timeline row says about the hour its bus actually leaves at. Issue #344.
 *
 * The owner's case, in his words: land at 3am, the metro is closed, and the answer is a
 * night bus or a taxi. The app already plans for the right moment (#135) and already picks
 * transit whenever transit exists, so the row it produces is a real timetable for a real
 * journey with a wait in front of it that nothing said out loud. `5:49am` in the row's
 * clock column is true and quiet; nine hours after landing is the fact that changes a
 * decision.
 *
 * Said only when the wait is longer than a headway. Under that it is not news, and
 * `NORMAL_WAIT_THRESHOLD_MINUTES` carries the argument for where the line is. `undefined`
 * otherwise, and the row says nothing, which is what it did before.
 *
 * This deliberately does not change which transfer is the pick. See
 * `search/transit-schedule.ts`'s `fetchTransitSchedules` for why that rule stayed and what
 * it would take to move it.
 */
export function transitDepartureWaitNote(wait: Duration | undefined, intended: LocalDateTime): string | undefined {
	if (wait === undefined || wait <= NORMAL_WAIT_THRESHOLD_MINUTES) return undefined;
	return `First departure ${formatClockTime(intended)}, ${formatDuration(wait)} after you land.`;
}

/**
 * Who a fare range covers, in the words a row prints. Issue #344.
 *
 * Shared by the transport picker and the receipt so one trip cannot say "for 4" in one
 * place and nothing in the other about the same ride. `undefined` for a party of one and
 * for a rate card whose basis is unchecked, which are the two cases `FareParty` exists to
 * keep apart from each other and from a party fare.
 *
 * The car count is in the sentence whenever there is more than one, because "for 5" over a
 * figure that is really two taxis is the kind of quiet arithmetic this app keeps having to
 * undo. See `TAXI_SEATS_PER_VEHICLE` for why five people are two cars.
 */
export function fareAudience(party: FareParty | undefined): string | undefined {
	if (party === undefined || party.basis === 'unknown') return undefined;
	return party.vehicles > 1
		? `for ${party.people} in ${party.vehicles} taxis`
		: `for ${party.people}`;
}

/** What one traveller pays of `estimate` if the party splits it, or nothing when nothing
 * licenses the division. Issue #344, and absent in exactly the cases `fareAudience` is.
 * Unexported because a caller wanting this wants the whole note. */
function fareEachShare(estimate: FareRange): string | undefined {
	const { party } = estimate;
	if (party === undefined || party.basis === 'unknown') return undefined;
	return `${formatMoneyRange(party.perPersonLowMinorUnits, party.perPersonHighMinorUnits, estimate.currency)} each`;
}

/**
 * What one transfer row prints where a price goes, and what kind of claim it is making.
 *
 * Three booleans over five states rather than the state itself, because they are the three
 * questions the screens actually ask and answering them once here is what stops four
 * components each deriving them differently. "No fare" against a walk is the case that
 * needs all three: it is not an amount, it is not an estimate, and it is not an admission.
 */
export interface TransferFareNote {
	text: string;
	/** `text` is a figure, so a sentence can append "each way" to it and a column can set it
	 * in tabular numerals. True for a quote and for a range. */
	amount: boolean;
	/** Who `text` covers, when that is worth saying: "for 4", or "for 5 in 2 taxis". Issue
	 * #344, and `undefined` for a lone traveller, where the party's fare and the head's are
	 * the same number, and for a rate card whose basis nobody has checked, where the
	 * division is not licensed. Same rule and the same wording as `NightlyRate.audience`
	 * next door in `stays/pricing.ts`. */
	audience?: string;
	/** What one of the party pays if they split `text`: "about €13-€20 each". Present with
	 * `audience` and absent without it. This is the figure that compares with a bus ticket,
	 * which is the comparison issue #344 was opened about. */
	each?: string;
	/** A rate-card range rather than a fare anybody quoted, so a caller can tag it the way
	 * `TransportPicker` and `PriceLine` both do. Never true unless `amount` is. */
	estimated: boolean;
	/** An admission rather than an amount, so a caller can grey it out. False for a walk,
	 * whose "no fare" is a fact about walking. */
	unknown: boolean;
}

/**
 * What a transfer row says about its own fare, in one place, for every screen that shows a
 * transfer.
 *
 * Issue #119, the owner on a walking option: **"and price of walk is 0€..."**. That zero is
 * long gone, since no `TransferProvider` sets `Transfer.price` at all, but the note that
 * replaced it put walking and a bus in the same bucket, and they are not the same fact.
 * Walking has no fare, which this app knows and which is the reason walking is worth
 * offering. A bus with no price is a gap in what Transitous told us.
 *
 * Issue #249 adds the two the app has since learned to tell apart, and takes a `Transfer`
 * rather than a `TransferMode` because a mode cannot answer either of them. A short taxi
 * carries a rate-card range, and a long one carries issue #246's refusal to guess. This
 * printed "Price not available" for both, which put the words "price not available"
 * directly under a receipt line reading "£35.85-£55.58 ESTIMATE" for the same ride.
 * Measured on a live build on 2026-09-05, in `StopoverBlock`'s own sentence. One screen
 * cannot say both.
 *
 * `compact` is the timeline's own price column, which sits under real money on a 375px
 * screen and cannot take a full sentence. The picker gives the note a row to itself.
 */
export function transferFareNote(transfer: Transfer, compact = false): TransferFareNote {
	const fare = groundFare(transfer);
	switch (fare.kind) {
		case 'free':
			return {
				text: compact ? 'no fare' : 'No fare',
				amount: false,
				estimated: false,
				unknown: false
			};
		case 'quoted':
			return { text: formatMoney(fare.price), amount: true, estimated: false, unknown: false };
		case 'estimated':
			return {
				text: formatMoneyRange(
					fare.estimate.lowMinorUnits,
					fare.estimate.highMinorUnits,
					fare.estimate.currency
				),
				amount: true,
				estimated: true,
				unknown: false,
				audience: fareAudience(fare.estimate.party),
				each: fareEachShare(fare.estimate)
			};
		case 'beyond-rate-card':
			// Issue #246. The column is too narrow for the reason; `TransportPicker`'s own
			// disclosure carries it, and this states the fact.
			return {
				text: compact ? 'no estimate' : 'No fare estimate',
				amount: false,
				estimated: false,
				unknown: true
			};
		case 'unquoted':
			return {
				text: compact ? 'price n/a' : 'Price not available',
				amount: false,
				estimated: false,
				unknown: true
			};
	}
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
		 *
		 * Issue #347 added the walking half. It reaches this row far less often than the road
		 * half does, because a walk that trips the 45-minute cap usually sits beside a driving
		 * route that did not, and then the leg has a transfer and this function is never
		 * called at all. `TransportPicker` is where that common case gets said. This is for
		 * the leg where a refused walk was the whole answer.
		 */
		withheld?: WithheldTransfers;
	}
): string {
	if (leg === 'to-hotel' || leg === 'from-hotel') {
		// Issue #243: the traveller picked a property off the stay list, and the search
		// routes to the one property it picks itself and no other, so nothing has ever been
		// asked about this address. Distinct from the last sentence in this branch, which
		// would blame a transport provider for refusing a question nobody put to it.
		//
		// First, and that matters more than it looks. `withheld` below describes the leg
		// the SEARCH routed, to the property the search picked. Once the traveller has moved
		// to a different one, that refusal is about an address they are no longer looking at,
		// and printing "the road route in takes 33h" beside this property's name would be
		// #243's own wrong-address bug arriving from the other direction. Reorder these two
		// and `itinerary-timeline-format.test.ts` fails on purpose.
		if (context.nightsInConnection === 0) {
			// Issue #231 split the nightless trip in two. Both book nothing, but one of them
			// is awake in a terminal at 3am, and telling that traveller their connection is
			// same-day is the app describing a different journey from the one they are on.
			//
			// Above `unrouted-stay` and no longer conditioned on there being no bed at all,
			// both since issue #365. A nightless stopover can carry a bed the search quoted
			// and did not book, and `build.ts` takes the two legs off it precisely BECAUSE
			// no night is spent here. Saying "nothing routed to this property" there blames a
			// transport provider for a decision this app made, which is the same wrong-cause
			// sentence AGENTS.md keeps having to remove. Measured on the owner's own card:
			// "The bed is priced, but no transport provider could route to it", printed over
			// a metro route the app had found and then correctly discarded.
			return context.overnightWait
				? 'Overnight wait, so there is no hotel leg here.'
				: 'Same-day connection, so there is no hotel leg here.';
		}
		if (context.transferAnchor === 'unrouted-stay') {
			return leg === 'to-hotel'
				? 'Nothing routed to this property, so the journey to it is unknown.'
				: 'Nothing routed back from this property, so the journey back is unknown.';
		}
		// Above the two "nothing routed" sentences below, and above #211's, because it
		// contradicts all three. "Nothing routed into the city" is as false as "no transport
		// provider could route to it" when a router answered at 33 hours and this app refused
		// the answer. Below the nightless branch, though: that traveller is not going to a
		// bed at all, and the refusal is true and irrelevant to them.
		const refused = withheldNote(leg, context.withheld);
		if (refused) return refused;
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
	return (
		withheldNote(leg, context.withheld) ?? 'No route came back from the transport providers for this leg.'
	);
}

/**
 * The refusal this row leads with. Road before walk, because a walk over 45 minutes is the
 * expected consequence of a drive that already takes hours, and printing both would spend a
 * second clause on the first one's echo.
 *
 * `undefined` when nothing was refused, which is nearly every leg.
 */
function withheldNote(leg: UnroutedLeg, withheld: WithheldTransfers | undefined): string | undefined {
	if (withheld?.road) return refusedRouteSentence(ROAD_SUBJECT[leg], withheld.road);
	if (withheld?.walk) return refusedRouteSentence(WALK_SUBJECT[leg], withheld.walk);
	return undefined;
}

/** A table rather than a nested ternary per mode: two modes times four legs is where the
 * conditional version stopped being readable, and a `Record` over the union is also what
 * makes a fifth leg a compile error instead of a silent fall-through to the generic form. */
const ROAD_SUBJECT: Record<UnroutedLeg, string> = {
	'to-hotel': 'The road route in',
	'from-hotel': 'The road route back',
	'to-origin-airport': 'The road route',
	'to-destination-location': 'The road route'
};

const WALK_SUBJECT: Record<UnroutedLeg, string> = {
	'to-hotel': 'The walk in',
	'from-hotel': 'The walk back',
	'to-origin-airport': 'The walk',
	'to-destination-location': 'The walk'
};

/**
 * One refused mode, in the duration it came back with and the distance it was judged
 * against. Both numbers, always, and that is the sentence's job rather than a decoration on
 * it: 33 hours to cover 157 km reads as a journey nobody could take, and 1h 13m to cover
 * 1.4 km reads as a router measuring from the wrong side of a runway, which is exactly what
 * happens at the 653 airports with no terminal mapped (issue #347). A traveller can act on
 * the second and this app cannot, so it prints what it saw and leaves the reading to them.
 *
 * Deliberately does not print `WithheldRoutes.count`. Driving and taxi are one OSRM route
 * wearing two labels (`providers/transfers/osrm.ts`), so the count is almost always 2 for
 * road and 1 for walking, and "2 routes" would describe two options where the traveller has
 * one. `TransportPicker`'s transit notice does print its count, because a timetable really
 * can return several different journeys.
 */
export function refusedRouteSentence(subject: string, withheld: WithheldRoutes): string {
	return `${subject} takes ${formatDuration(withheld.quickest)} to cover ${formatKilometres(withheld.straightLineKm)} in a straight line, so it is not offered.`;
}

/**
 * Issue #266: what a transit row says once the moment its timetable was planned for has
 * stopped being the moment the traveller is making that journey.
 *
 * The two kinds of leg fail in opposite directions and cannot share a sentence. A leg that
 * ends at a departure gate has a deadline that a waiting-time edit moves, so what changed
 * is when the traveller has to be there. A leg that starts at a runway has a landing that
 * a flight swap moves, so what changed is when they get out of the terminal. Printing the
 * deadline wording over a runway leg would tell somebody who has just landed that they are
 * late for a bus they were never catching.
 *
 * Here rather than in the markup so the branch has one home and a test can read it without
 * a Svelte runtime.
 */
function staleScheduleClause(plannedFor: TransitPlanMoment, happensAt: LocalDateTime): string {
	return plannedFor.arriveBy
		? `you now need to be there by ${formatClockTime(happensAt)}`
		: `you now leave the airport at ${formatClockTime(happensAt)}`;
}

/** The timeline row's own sentence, which has the width for the consequence as well. */
export function staleScheduleNote(plannedFor: TransitPlanMoment, happensAt: LocalDateTime): string {
	return (
		`Timetable planned for ${formatClockTime(plannedFor.time)}, and ` +
		`${staleScheduleClause(plannedFor, happensAt)}, so these departures are not the ones to catch.`
	);
}

/** The same fact as a segment stub's "If you miss it" value, where the label carries the
 * question and the value only has room for the answer. */
export function staleScheduleFact(plannedFor: TransitPlanMoment, happensAt: LocalDateTime): string {
	return `Planned for ${formatClockTime(plannedFor.time)}, and ${staleScheduleClause(plannedFor, happensAt)}`;
}
