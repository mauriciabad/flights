/**
 * Issue #135: asks public transport about the journey the traveller is actually making.
 *
 * ## Why this cannot live where the other transfer lookups live
 *
 * `fetchOuterTransfers` resolves once per search and `fetchConnectionResources` runs before
 * that candidate's flights come back, so at both of those points the only "when" available
 * is the moment the search ran. That is what shipped: a Barcelona search made at 11:07 on a
 * Thursday in September asked Transitous for `time=2026-09-04T11:07:24Z&arriveBy=false` and
 * printed the answer as the plan for a 06:15 check-in on a Sunday three weeks later, Metro
 * L1 and all. The metro does not run at that hour. The real answer was the N17 night bus,
 * and no amount of care further down the pipeline could have found it, because the question
 * was wrong before it left the browser.
 *
 * A timetable is only meaningful for one moment, and the moment belongs to the itinerary,
 * not to the search. So this runs after `buildItineraries`, where both flights are known,
 * and it is the only place in the app that asks a transit provider anything.
 *
 * ## The two questions, and why the leg decides which one is asked
 *
 * A leg that ENDS at a departure gate (origin location to the airport, hotel to the
 * connection airport) is a deadline: be there by boarding time minus the airport waiting
 * buffer. `arriveBy=true` answers it, and the last departure that still makes it is the one
 * the traveller wants, because it is the one that lets them leave latest.
 *
 * A leg that STARTS at a runway (connection airport to the hotel, destination airport to
 * the destination) is the opposite: the traveller is free from landing plus the walk out of
 * the terminal, and wants the first departure after that, plus the ones behind it.
 *
 * ## What it costs
 *
 * One `/plan` request per transit leg of an itinerary that is refined, and refinement is
 * capped per search by `createTransitLookupBudget`. Answering "what if you miss the last
 * one" adds nothing on top: MOTIS returns the departures after the intended one in the same
 * response, so the overnight gap is already in hand, and on an `arriveBy` plan "nothing
 * later gets you there in time" is what `arriveBy` means rather than something to go and
 * ask. Transitous is free but volunteer-run, and the cap is what keeps a search's cost a
 * fixed number instead of a multiple of however many stopovers the route graph offered.
 */

import type {
	Coordinates,
	Duration,
	IataAirportCode,
	Itinerary,
	Transfer,
	TransitPlanMoment
} from '../domain';
import { greatCircleDistanceKm } from '../domain';
import { countTransitBoardings, estimateTransitFare } from '../providers/transfers/transit-fare-table';
import { addLocalMinutes } from '../algorithm/build';
import { recomputeItinerarySelection } from '../algorithm/recompute-selection';
import { transitLegMoment } from '../algorithm/transit-schedule';
import type { AvailableKeys, ProviderError, ProviderResult, TransferProvider } from '../providers/types';
import { applyLandingBuffer, fetchBestTransfer, summariseWithheldRoutes } from './resources';
import type { RecordProviderCall, SourceTracker } from './provenance';
import { providerAnswer } from './provenance';
import type { ProviderAnswer } from './provenance';
import type { TransitLegAnswer, TransitLegAnswers, TransitLegField, WithheldRoutes } from './types';

/**
 * How many `/plan` requests one search may spend, across every itinerary it refines.
 *
 * The shape of the risk, measured on the issue's own URL against production on 2026-09-04:
 * a search there makes 49 Ryanair requests, 4 OSRM requests and 2 Transitous requests, and
 * produces 2 itineraries. Refining both of those costs 4 requests with no bed priced (the
 * two outer legs each), 8 with one. A route that produced six stopovers would cost 12 to
 * 24, and issue #115's 24-candidate fallback sweep could in principle go further — except
 * that sweep only runs when nothing was buildable at all, so there is nothing to refine.
 *
 * Twelve is deliberately a whole number of itineraries either way: six two-leg itineraries,
 * or three with a bed priced. Past it, the remaining itineraries keep their road-mode
 * transfers and say so (`'budget-spent'`), which is a visibly worse answer rather than a
 * quietly wrong one.
 */
export const MAX_TRANSIT_LOOKUPS_PER_SEARCH = 12;

/** One search's ration of transit lookups, shared by every candidate in it — the same
 * shape and the same reasoning as issue #148's `StayLookupBudget`, applied to a free but
 * volunteer-run provider instead of a metered one. Claims are synchronous, so candidates
 * racing each other cannot overspend it between them. */
export interface TransitLookupBudget {
	/** Takes one lookup, returning whether there was one left to take. */
	claim(): boolean;
	/** How many have been taken so far. For tests, and for saying what a search spent. */
	spent(): number;
}

export function createTransitLookupBudget(limit: number = MAX_TRANSIT_LOOKUPS_PER_SEARCH): TransitLookupBudget {
	let used = 0;
	return {
		claim() {
			if (used >= limit) return false;
			used += 1;
			return true;
		},
		spent() {
			return used;
		}
	};
}

/** A budget that never refuses, for a caller with no fan-out to ration — a test, or a
 * single deliberate lookup. Mirrors `createUnboundedStayLookupBudget`'s reason for
 * existing: saying "one lookup, on purpose" rather than passing `undefined` and reopening
 * the hole the budget closes. */
export function createUnboundedTransitLookupBudget(): TransitLookupBudget {
	let used = 0;
	return {
		claim() {
			used += 1;
			return true;
		},
		spent() {
			return used;
		}
	};
}

/** One leg of an itinerary, and the exact question to ask about it. */
export interface TransitLegPlan {
	field: TransitLegField;
	from: Coordinates;
	to: Coordinates;
	moment: TransitPlanMoment;
	/**
	 * The airport this leg runs to or from, which is what `transit-fare-table.ts` prices a
	 * ticket at. Issue #407.
	 *
	 * Not optional, because every leg planned below has exactly one airport at one end and
	 * that is worth stating rather than rediscovering. The two outer legs run to the origin
	 * airport and from the destination airport; the two connection-side legs run from and
	 * back to the stopover's airport. There is no fifth shape, and a transit fare that had
	 * to guess which end was the airport would be pricing a journey it had not identified.
	 */
	airport: IataAirportCode;
	/**
	 * The walk-out time this leg's `moment` was built from, for a leg that starts at a
	 * runway, so whatever answers the plan can pad the journey by the same number the
	 * question was asked with. Absent on a leg that ends at a departure gate, which is
	 * already covered by the pre-boarding buffer and must never be padded again.
	 *
	 * Carried on the plan rather than looked up again from the input, so "this leg needs
	 * padding" and "here is the padding" are one fact. They used to be two, and the second
	 * one could be missing while the first said yes.
	 */
	landingBuffer?: Duration;
}

export interface PlanTransitLegsInput {
	itinerary: Itinerary;
	/** The connection airport's own coordinates. Not on `Itinerary` — it carries the
	 * connection as an IATA code on the flights — so the caller, which resolved the airport
	 * to build the itinerary in the first place, hands it over rather than re-resolving. */
	connectionCoordinates?: Coordinates;
	/** `pickLandingToTransportTime` for the connection airport: how long after touchdown the
	 * traveller can realistically be at a stop. Already folded into `transferToHotel`'s
	 * duration by `applyLandingBuffer`, and needed separately here because the question is
	 * "from when", not "how long".
	 *
	 * Optional since issue #267, and a runway leg with no buffer is not planned at all. A
	 * caller asking about one leg should not have to invent a number for an airport it is
	 * not asking about, and a made-up buffer would be a made-up journey moment. */
	connectionLandingBuffer?: Duration;
	/** The same, for the destination airport. */
	destinationLandingBuffer?: Duration;
	/**
	 * Issue #267: ask about these legs and no others. Absent means every leg the itinerary
	 * has, which is what a search asks.
	 *
	 * The detail panel asks about the two in-city legs alone. A bed swap moves those two to
	 * an address nobody holds a timetable for and leaves the outer two exactly as they
	 * were, so re-asking all four would spend two lookups on legs the swap never touched.
	 * Against a volunteer-run service rationed to `MAX_TRANSIT_LOOKUPS_PER_SEARCH` per
	 * search, that is the difference between a traveller's deliberate question costing 2
	 * and costing 4.
	 */
	fields?: readonly TransitLegField[];
}

/** The two legs a bed swap moves: issue #267's on-demand check asks about exactly these. */
export const TRANSIT_LEGS_TO_A_PROPERTY: readonly TransitLegField[] = [
	'transferToHotel',
	'transferToConnectionAirport'
];

/**
 * Every transit question this itinerary raises, each with the moment that makes it
 * answerable. Legs the trip does not have (no origin location given, no bed priced for the
 * stopover) simply do not appear.
 */
export function planTransitLegs(input: PlanTransitLegsInput): TransitLegPlan[] {
	const { itinerary } = input;
	const plans: TransitLegPlan[] = [];

	// The check-in deadline, not the flight: `originWaitingTime` is the pre-boarding buffer
	// the traveller chose (brief line 39, default 2h), so being at the airport by this moment
	// is the actual requirement. `transitLegMoment` owns that arithmetic, because issue #266
	// needs the same moment recomputed later to notice the answer has stopped applying.
	const originMoment = transitLegMoment(itinerary, 'transferToOriginAirport');
	if (itinerary.originLocation && originMoment) {
		plans.push({
			field: 'transferToOriginAirport',
			from: itinerary.originLocation.coordinates,
			to: itinerary.originAirport.coordinates,
			moment: originMoment,
			airport: itinerary.originAirport.iataCode
		});
	}

	// Issue #365: a stopover that books no night books no bed, so there is no address here
	// to plan a journey to, and `pairConnections` has already taken the two legs off the
	// trip. Without this gate the refinement puts them straight back, since it reads the bed
	// rather than the legs, and it spends one of a volunteer-run service's requests doing it.
	if (itinerary.stay && itinerary.nightsInConnection > 0 && input.connectionCoordinates) {
		// Only the runway leg needs the buffer. The ride back to the airport is a deadline
		// and derives its own moment, so it is still planned when nobody supplied one.
		if (input.connectionLandingBuffer !== undefined) {
			plans.push({
				field: 'transferToHotel',
				from: input.connectionCoordinates,
				to: itinerary.stay.property.coordinates,
				moment: { time: addLocalMinutes(itinerary.outboundFlight.arrival, input.connectionLandingBuffer), arriveBy: false },
				landingBuffer: input.connectionLandingBuffer,
				airport: itinerary.outboundFlight.arrivalAirport
			});
		}
		const connectionMoment = transitLegMoment(itinerary, 'transferToConnectionAirport');
		if (connectionMoment) {
			plans.push({
				field: 'transferToConnectionAirport',
				from: itinerary.stay.property.coordinates,
				to: input.connectionCoordinates,
				moment: connectionMoment,
				airport: itinerary.outboundFlight.arrivalAirport
			});
		}
	}

	if (itinerary.destinationLocation && input.destinationLandingBuffer !== undefined) {
		plans.push({
			field: 'transferToDestinationLocation',
			from: itinerary.destinationAirport.coordinates,
			to: itinerary.destinationLocation.coordinates,
			moment: { time: addLocalMinutes(itinerary.onwardFlight.arrival, input.destinationLandingBuffer), arriveBy: false },
			landingBuffer: input.destinationLandingBuffer,
			airport: itinerary.destinationAirport.iataCode
		});
	}

	return input.fields ? plans.filter((plan) => input.fields!.includes(plan.field)) : plans;
}

export interface FetchTransitSchedulesInput extends PlanTransitLegsInput {
	transferProviders: readonly TransferProvider[];
	keys: AvailableKeys;
	signal: AbortSignal;
	sources: SourceTracker;
	record: RecordProviderCall;
	budget: TransitLookupBudget;
	minLayoverTime?: Duration;
}

export interface TransitScheduleOutcome {
	/** The itinerary with every transit leg that was found swapped in, and every derived
	 * field recomputed for the new durations. The same object when nothing changed. */
	itinerary: Itinerary;
	/** What each leg's lookup actually said, including the legs nobody asked about and why
	 * — the honest-gap half of issue #135. */
	answers: TransitLegAnswers;
}

/**
 * Asks about every transit leg of one itinerary, at that leg's own moment, and folds what
 * comes back into the itinerary.
 *
 * A transit answer always becomes the pick when one is found, which is not a new rule: it
 * is exactly `pickBestTransfer`'s existing mode preference (`'transit'` first), applied at
 * the point transit finally has a real timetable behind it. Without this step the pipeline's
 * road-only lookups would leave a two-hour walk as the pick for an airport run a night bus
 * covers in forty minutes.
 *
 * ## Why the hour does not move that rule. Issue #344
 *
 * The owner asked for it to: land at 3am, the metro is shut, "usually in this cases a taxi
 * may be worth it". #282 left the same question open from the other end, a press replacing
 * a 35-minute taxi with a bus at 5:49am, nine hours after landing. It was looked at
 * properly and the rule stays, for reasons that are about evidence rather than caution.
 *
 * **The comparison a traveller is actually making has no money in it.** "Worth it" is a
 * price against a wait, and no `TransferProvider` here quotes a transit fare (issue #292,
 * and `domain/transfer.ts`'s `costIsUnknown`). The app holds a rate-card range for the taxi
 * and nothing at all for the bus. Flipping the default to the expensive option on half the
 * evidence is a worse error than leaving it.
 *
 * **The clock is a proxy for the fact, and the fact is already measured.** Barcelona's
 * metro runs all night on a Saturday and stops at midnight on a Tuesday, so an
 * "unsociable hours" window would swap the pick where the service is running and leave it
 * where it is shut. The wait is the observable, `transitDepartureWait` in
 * `algorithm/transit-schedule.ts` computes it, and #344 puts it on the row instead.
 *
 * **A rule on time alone deletes public transport.** A taxi beats a bus on time nearly
 * always; "pick whatever arrives first" is "always pick the taxi" with extra steps, against
 * an app whose whole pitch is the trip you can do without a car.
 *
 * What would make the pick moveable is a transit fare to weigh against the taxi's. Until
 * then the honest change is the one #344 made: say what the taxi costs the party, say what
 * that is each, say what hour the bus leaves at, and let the traveller decide with the
 * picker one tap away.
 */
export async function fetchTransitSchedules(input: FetchTransitSchedulesInput): Promise<TransitScheduleOutcome> {
	const plans = planTransitLegs(input);
	const answers: TransitLegAnswers = {};
	// Keyed by transit leg rather than typed as the whole `SelectionOverrides`: this only
	// ever replaces transfers, and naming that lets `applyUsableOverrides` fold them in one
	// at a time without casting a flight-shaped field back to a `Transfer`.
	const overrides: Partial<Record<TransitLegField, Transfer>> = {};

	// Sequential, not `Promise.all`: the budget is the point, and a leg that would have been
	// refused should not have been sent while three siblings were in flight. It also keeps
	// this app's one-request-at-a-time manners toward a volunteer-run service.
	for (const plan of plans) {
		if (input.signal.aborted) break;
		if (!input.budget.claim()) {
			answers[plan.field] = { answer: 'not-asked', reason: 'budget-spent', plannedFor: plan.moment };
			continue;
		}

		const outcome = await fetchBestTransfer(
			{ from: plan.from, to: plan.to, departure: plan.moment.time, arriveBy: plan.moment.arriveBy, modes: ['transit'] },
			input.transferProviders,
			input.keys,
			input.signal,
			input.sources,
			input.record
		);

		const found = outcome.candidates.filter((transfer) => transfer.mode === 'transit');
		answers[plan.field] = readLegAnswer(outcome.results, plan.moment, {
			// Issue #220: only worth reporting when it is the whole answer. A leg that also
			// found a real bus has the bus to show, and a sentence about a route nobody is
			// being offered would be noise on a row that is already right.
			rejected: found.length === 0 ? outcome.rejected : [],
			straightLineKm: greatCircleDistanceKm(plan.from, plan.to)
		});
		if (found.length === 0) continue;

		// Only a leg that starts at a runway gets the landing buffer, the same rule
		// `resources.ts` follows and for the same reason: a leg ending at a departure gate
		// is already covered by the pre-boarding waiting time and would double-count it.
		// The plan carries the number it was asked with, so the answer is padded by exactly
		// the minutes the question assumed and there is nothing to look up a second time.
		const landingBuffer = plan.landingBuffer;
		const buffered =
			landingBuffer === undefined
				? found
				: found.map((transfer) => applyLandingBuffer(transfer, landingBuffer, input.sources));
		overrides[plan.field] = withTransitFare(pickShortest(buffered), plan, input.itinerary);
	}

	return { itinerary: applyUsableOverrides(input, overrides), answers };
}

/**
 * Folds the transit picks into the itinerary one leg at a time, keeping only the ones that
 * leave the traveller some free time in the stopover.
 *
 * A transit plan is only better than the road leg it replaces while the trip survives it.
 * Transitous can answer a short connection with a three-change journey that takes longer
 * than the whole layover, and `recomputeItinerarySelection` returns exactly that itinerary
 * with an `insufficient-connection-time` warning attached, which this function used to
 * discard along with the warning. The card then printed "-19h 38m in Birmingham".
 *
 * That was invisible while only the longest pairing through each city was ever refined:
 * a four-night stopover absorbs a slow bus without noticing. Issue #224 makes the SHORTEST
 * pairing the one on screen and therefore the one refined, and a short layover is where the
 * arithmetic actually bites. Nothing about the old behaviour was right, it was just never
 * exercised.
 *
 * Rejecting one leg rather than the whole refinement: the two ends of a stopover are
 * independent, and a night bus into town is worth keeping even when the ride back is a
 * three-change trek this drops. The dropped leg keeps its road-mode transfer, which is what
 * the itinerary already had, and its `answers` entry still reports what the timetable said,
 * because "we asked and this is the journey" stays true whether or not the trip can afford
 * it.
 */
function applyUsableOverrides(
	input: FetchTransitSchedulesInput,
	overrides: Partial<Record<TransitLegField, Transfer>>
): Itinerary {
	let itinerary = input.itinerary;
	for (const field of Object.keys(overrides) as TransitLegField[]) {
		const transfer = overrides[field];
		if (!transfer) continue;
		const recomputed = recomputeItinerarySelection(itinerary, { [field]: transfer }, input.minLayoverTime);
		if (recomputed.warnings.some((warning) => warning.code === 'insufficient-connection-time')) continue;
		itinerary = recomputed.itinerary;
	}
	return itinerary;
}

/**
 * Turns one leg's provider results into the four-state answer issue #130 already defined,
 * read by that issue's own `providerAnswer` rather than a second vocabulary invented here.
 * The distinction it exists to preserve: Bucharest's `itineraries: []` is Transitous
 * answering that it has no timetable for the area, and an empty results list is nobody
 * having been asked. The picker has to be able to say which.
 */
function readLegAnswer(
	results: readonly ProviderResult<Transfer[]>[],
	plannedFor: TransitPlanMoment,
	refused: { rejected: readonly Transfer[]; straightLineKm: number }
): TransitLegAnswer {
	if (results.length === 0) return { answer: 'not-asked', reason: 'no-provider', plannedFor };

	let okCalls = 0;
	let okCallsWithData = 0;
	let lastError: ProviderError | undefined;
	for (const result of results) {
		if (result.ok) {
			okCalls += 1;
			if (result.data.length > 0) okCallsWithData += 1;
		} else {
			lastError = result.error;
		}
	}

	const answer: ProviderAnswer = providerAnswer({ lastError, okCalls, okCallsWithData });
	return {
		answer,
		plannedFor,
		error: answer === 'failed' ? lastError : undefined,
		withheld: readWithheld(refused)
	};
}

/** Issue #220: the refused routes, reduced to the numbers a card can print. The caller
 * decides whether there is anything to report at all. Only the transit ones: this leg's
 * rejects can also hold a drive the road rule refused (issue #119), and that one is
 * reported by the timeline's own unrouted-leg row, not by a sentence about buses. */
function readWithheld(refused: {
	rejected: readonly Transfer[];
	straightLineKm: number;
}): WithheldRoutes | undefined {
	return summariseWithheldRoutes(refused.rejected, refused.straightLineKm, ['transit']);
}

/** Among transit options for one leg, the quickest — the same tie-break `pickBestTransfer`
 * applies within a mode, kept here so the two can never disagree about which bus is "the"
 * one. */
function pickShortest(transfers: readonly Transfer[]): Transfer {
	return [...transfers].sort((a, b) => a.duration - b.duration)[0];
}

/**
 * The transit answer, carrying what a ticket for it costs where a rate card covers the
 * airport. Issue #407.
 *
 * `price` stays unset, always, exactly as `taxiTransfer` in `providers/transfers/osrm.ts`
 * leaves it. Transitous returns a timetable and nothing in it is a fare, so the guess goes
 * in `fareEstimate`, whose type a caller cannot assign to `price` by accident
 * (`domain/fare.ts`), and `groundFare` in `domain/transfer.ts` is what makes every reader
 * choose between the two deliberately. Nothing here reaches `Itinerary.totalPrice`.
 *
 * Here rather than inside the Transitous adapter, which is where the taxi's equivalent
 * lives, for one reason: that adapter caches the mapped `Transfer` in IndexedDB, and a fare
 * is computed for one search's currency and one search's party. A cached transfer carrying
 * a fare would serve a euro figure to a search asking in pounds and one traveller's ticket
 * to a party of four, and it would go on doing it for the life of the entry. AGENTS.md's
 * own #131 lesson, from the other side: rather than give the cache a new key for a value
 * whose shape changed, keep the value the cache holds a timetable and compute the fare
 * after reading it.
 *
 * The currency comes off `itinerary.totalPrice` rather than being threaded down from the
 * search, and that is deliberate too. It is the currency the flights were quoted in and
 * therefore the one printed three lines above this fare on the same card, so the two cannot
 * drift apart, and neither of this function's two callers has to remember to pass it.
 * Issue #339 is the bug that argument comes from: an estimate in the ride's own currency
 * under a total in the traveller's is a figure nobody can compare with anything.
 */
function withTransitFare(transfer: Transfer, plan: TransitLegPlan, itinerary: Itinerary): Transfer {
	const fareEstimate = estimateTransitFare(
		plan.airport,
		greatCircleDistanceKm(plan.from, plan.to),
		countTransitBoardings(transfer.legs),
		itinerary.totalPrice.currency,
		itinerary.travellers
	);
	return fareEstimate ? { ...transfer, fareEstimate } : transfer;
}
