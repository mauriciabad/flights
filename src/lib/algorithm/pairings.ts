/**
 * Issue #387: a stopover's pairings have two axes, and until now only one had a control.
 *
 * `build.ts` emits one `Itinerary` per (outbound, onward) pair and `group.ts` keeps them
 * together as `ItineraryGroup.variants`. That set is a grid, not a list. One axis is how
 * many nights the pairing spends in the city, which `stopover-length.ts` folds into the
 * ladder the owner says works. The other is which day the traveller leaves, and it had
 * nothing at all:
 *
 * > i want to know what's the best combination for flying on the 17 for example I can't
 * > because it shows this message and I have to manually figure out the best outgoing
 * > flight
 *
 * The message he means is `flights-out-of-order`, and it appears because picking an
 * outbound has never moved the onward flight that goes with it. Both halves of that are
 * the same missing idea: **a pairing is chosen as a pairing**. Fix one flight or one date
 * and the rest of the trip follows from the set, rather than being left where the previous
 * trip put it.
 *
 * So every function here narrows `variants` by one constraint and then asks
 * `resolveStopover` which pairing that leaves. The narrowing differs; the resolution never
 * does, which is what stops the date ladder and the flight picker ranking the same trips
 * two different ways.
 *
 * Pure functions only, no I/O, no Svelte. Generic over the candidate for the same reason
 * `stopover-length.ts` is: `pipeline.ts` holds `ItineraryScore`s and `group.ts` holds
 * `ItineraryResult`s, and neither shape belongs in `algorithm/`.
 */

import type { FlightOffer } from '../domain';
import {
	defaultStopoverLength,
	stopoverLengths,
	stopoverOfLength,
	type StopoverLength
} from './stopover-length';

/**
 * One flight's identity for comparison purposes: the same physical departure offered twice
 * by two providers is one flight, not two. Carrier, number and local departure together,
 * because a flight number alone repeats daily and every list here spans several days.
 *
 * Lives in `algorithm/` rather than beside the picker that first needed it, because since
 * this issue the ladder, the picker and the pairing search all have to agree on when two
 * offers are the same flight. `components/picker-alternatives.ts` re-exports it.
 */
export function flightKey(flight: FlightOffer): string {
	return `${flight.carrier.iataCode}${flight.flightNumber}@${flight.departure.local}`;
}

/**
 * Whether two offers describe the same flight, by identity rather than by reference.
 *
 * Reference equality would be simpler and is wrong here. `build.ts` does pass provider
 * offers through unchanged, but these reach comparison through a Svelte `$state` array and
 * Svelte 5 deep-proxies state, so the same underlying offer read through two paths comes
 * back as two different proxies. Measured on production for BVC to PFO, that printed "Same
 * price, on different flights both ways" under every card's nights control, on trips where
 * nothing had changed at all.
 */
export function isSameFlight(a: FlightOffer, b: FlightOffer): boolean {
	return flightKey(a) === flightKey(b);
}

export type FlightLeg = 'outbound' | 'onward';

/**
 * The parts of an `Itinerary` this module reads, and no more.
 *
 * Narrower than `Itinerary` on purpose. It is the complete list of what a pairing has to
 * expose to be ranked along either axis, so the signature says what the ranking depends on
 * instead of leaving a reader to find out; and a fixture that satisfies it is three fields
 * rather than thirty. Every real caller passes a whole `Itinerary`, which fits.
 */
export interface PairingTrip {
	nightsInConnection: number;
	outboundFlight: FlightOffer;
	onwardFlight: FlightOffer;
}

export function flightOn(trip: PairingTrip, leg: FlightLeg): FlightOffer {
	return leg === 'outbound' ? trip.outboundFlight : trip.onwardFlight;
}

/**
 * The calendar date the trip leaves on, written the way a traveller writes it: the origin
 * airport's own local date, not an instant.
 *
 * `LocalDateTime.local` is already that airport's wall clock, so the first ten characters
 * are the date on the departure board the traveller will stand in front of. Converting to
 * UTC first is how an 11:40pm departure silently becomes the next day, which is exactly
 * the class of bug AGENTS.md's timezone section exists to prevent.
 */
export function departureDateOf(trip: PairingTrip): string {
	return trip.outboundFlight.departure.local.slice(0, 10);
}

/**
 * How to read one pairing, so every function here can rank candidates it deliberately
 * knows nothing about. One object rather than two loose callbacks because both are always
 * needed together and both take the same argument, which is how they get swapped.
 */
export interface PairingView<T> {
	tripOf: (candidate: T) => PairingTrip;
	/** `score.ts`'s `moneyCostOf`, at every call site. What the traveller pays. */
	costOf: (candidate: T) => number;
}

/** What a set of pairings offers, and which one of them to show. */
export interface ResolvedStopover<T> {
	/** Every length in the set, ascending. */
	lengths: StopoverLength<T>[];
	/** The length this set opens on with nothing requested: cheapest, ties to shortest. */
	minimum: StopoverLength<T> | undefined;
	/** The length actually shown: the requested one when the set can do it, else
	 * `minimum`. `undefined` only for an empty set. */
	chosen: StopoverLength<T> | undefined;
}

/**
 * Which pairing a set of candidates resolves to, given the length the traveller asked for.
 *
 * This expression used to live inline in `deriveScoredResult`, where it was the only
 * answer to "which trip is on screen" and so did not need a name. Issue #387 gives it three
 * more callers, and a rule with four callers and no name is a rule that gets answered four
 * ways: a date rung that ranked its trips by score while the card ranked its own by price
 * would put a EUR 186 saving on a rung and then not honour it when pressed.
 *
 * Exact rather than nearest on the requested length, deliberately, for the reason
 * `stopoverOfLength` gives: resolving "3 nights" to a 5-night pairing is the app choosing
 * the trip again. A set that cannot do the requested length falls to its own cheapest,
 * which is the same answer the card gives a traveller who has asked for nothing.
 */
export function resolveStopover<T>(
	candidates: readonly T[],
	view: PairingView<T>,
	requestedNights?: number
): ResolvedStopover<T> {
	const lengths = stopoverLengths(
		candidates,
		(candidate) => view.tripOf(candidate).nightsInConnection
	);
	const minimum = defaultStopoverLength(lengths, view.costOf);
	const chosen =
		(requestedNights === undefined ? undefined : stopoverOfLength(lengths, requestedNights)) ??
		minimum;
	return { lengths, minimum, chosen };
}

/** Every pairing that leaves on one date. Empty for a date this stopover cannot do. */
export function pairingsOn<T>(
	candidates: readonly T[],
	view: PairingView<T>,
	date: string
): T[] {
	return candidates.filter((candidate) => departureDateOf(view.tripOf(candidate)) === date);
}

/** One rung of a connection's departure-date ladder. */
export interface DepartureDate<T> {
	/** `YYYY-MM-DD` in the origin airport's own calendar. */
	date: string;
	/** The trip to take on this date: the requested length if the date can do it, else this
	 * date's cheapest. */
	pick: T;
	/** How many pairings leave on this date, `pick` included. */
	count: number;
}

/**
 * Every date this connection's pairings leave on, ascending, each with the best trip that
 * day.
 *
 * Ascending by date, and deliberately every date rather than a shortlist. A function that
 * returned days out of calendar order would hand every later reader a list to re-sort before
 * they could reason about it, and one that returned only some of them would leave
 * `chooseDepartureDate` unable to find the rung that was pressed.
 *
 * Which days a narrow row can actually draw, and in what order, is
 * `results/departure-ladder.ts`'s decision, the same split `stopover-nights.ts` already
 * makes. That is also where the owner's "shorted by best price" is answered, and its doc
 * comment argues the answer out.
 *
 * `requestedNights` is the other axis's pin. A traveller who asked for three nights and
 * then asks about Thursday should be offered Thursday's three-night trip, not Thursday's
 * cheapest, or the date ladder would quietly undo the nights ladder. A date that cannot do
 * the requested length offers its own cheapest instead, and the pin stays recorded, so
 * moving back to a date that can do it gets it back.
 */
export function departureDates<T>(
	candidates: readonly T[],
	view: PairingView<T>,
	requestedNights?: number
): DepartureDate<T>[] {
	const byDate = new Map<string, T[]>();
	for (const candidate of candidates) {
		const date = departureDateOf(view.tripOf(candidate));
		const existing = byDate.get(date);
		if (existing) existing.push(candidate);
		else byDate.set(date, [candidate]);
	}

	const dates: DepartureDate<T>[] = [];
	for (const [date, sameDay] of byDate) {
		const pick = resolveStopover(sameDay, view, requestedNights).chosen?.pick;
		// Unreachable: a date is in the map because a pairing put it there, so the set is
		// never empty. Guarded rather than asserted, since the alternative is a rung with no
		// trip behind it and a card that empties when it is pressed.
		if (pick) dates.push({ date, pick, count: sameDay.length });
	}
	return dates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * The best trip that flies this exact flight on this leg, and the fix for the sentence
 * issue #387 is named after.
 *
 * `recomputeItinerarySelection` replaces one flight and keeps the other exactly as it was,
 * which is right for what it is: a report of what the traveller picked, impossible or not.
 * Nothing was answering the question before it, which is "given that I leave on this
 * flight, what is the rest of the trip". Every pairing in `variants` already survived
 * `pairConnections`' minimum-layover and non-negative-free-time filters, so a pairing found
 * here is a trip that connects, and picking one can never produce the out-of-order warning.
 *
 * `undefined` when this flight appears in no pairing at all, which leaves the caller
 * holding the flight the traveller picked and the warning that describes it. That is the
 * case the warning is for, and it is why this returns rather than throws.
 */
export function pairingUsing<T>(
	candidates: readonly T[],
	view: PairingView<T>,
	leg: FlightLeg,
	flight: FlightOffer,
	requestedNights?: number
): T | undefined {
	const flying = candidates.filter((candidate) =>
		isSameFlight(flightOn(view.tripOf(candidate), leg), flight)
	);
	return resolveStopover(flying, view, requestedNights).chosen?.pick;
}
