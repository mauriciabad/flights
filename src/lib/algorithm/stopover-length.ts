/**
 * Issue #224: which of a connection city's flight pairings the traveller is shown first,
 * and which stopover lengths that city can offer instead.
 *
 * `build.ts` emits one `Itinerary` per (outbound, onward) pair, and `group.ts` keeps them
 * together as one stopover with many variants. Something has to pick the one the card
 * opens on. That used to be the highest-scoring variant, and `score.ts` pays 40 points for
 * the first night and 75% of the previous night for each one after, so the pick was
 * whichever pairing filled the search window: six nights beside Gatwick on a 6-to-12
 * October search, when the one-night trip landing on the 6th and flying out on the 7th was
 * in the same group and never shown.
 *
 * The owner, on that card:
 *
 * > i dont want to spend 6 lights in a hotel in middle of nowhere! it makes no sense
 *
 * > the nights should be kept to a minimum by default
 *
 * > and i can decide to add more nights if the city is interesting and the hotel in the
 * > center
 *
 * So the card opens on the shortest stopover this city can do, and every longer pairing
 * stays reachable through a control on that same card. That also un-rigs the comparison
 * between cities: every card's total used to cover however many nights that city's widest
 * pairing happened to span, so a EUR 13/night dorm 48km out beat a EUR 53/night room 2.8km
 * from the terminal on 6 x 13 against 6 x 53. Cards now compare like against like.
 *
 * One thing this module deliberately does NOT model: nights that are optional within one
 * pairing. Issue #225's price split reads as "the first night is mandatory, further nights
 * are +EUR x each", but a pairing's nights are fixed by its two flights. A longer stay is a
 * DIFFERENT pairing, usually on a different onward fare. So every night of the length on
 * screen is mandatory for that trip, and what a longer stay costs is a comparison between
 * two pairings, not a line item inside one. `results/stopover-nights.ts` computes it that
 * way, from real fares, rather than quoting a nightly rate that leaves out the fare change.
 *
 * Generic over the thing being chosen rather than typed to `Itinerary`: `pipeline.ts`
 * chooses among `ItineraryScore`s (before provenance is attached) and `group.ts` among
 * `ItineraryResult`s (after), and neither shape belongs in `algorithm/`.
 *
 * Pure functions only, no I/O, no Svelte.
 */

/** One stopover length a connection city can do, and the best candidate at that length. */
export interface StopoverLength<T> {
	/** Calendar nights in the connection city, `Itinerary.nightsInConnection`, which
	 * `build.ts` counts by dates crossed on the stopover's own clock, never by dividing
	 * free time by 24. */
	nights: number;
	/** The candidate to use at this length: the first one the caller listed with this
	 * night count. Callers pass their candidates best-first, so this is that length's
	 * best pairing rather than an arbitrary one. */
	pick: T;
	/** How many candidates share this night count, `pick` included. More than one means
	 * the traveller has a real choice of flight times without changing the length. */
	count: number;
}

/**
 * Every distinct stopover length among `candidates`, shortest first, each with the first
 * candidate that has it.
 *
 * Order within a length is the caller's: `group.ts` and `pipeline.ts` both hand this a
 * list already sorted best score first, so `pick` is the best pairing at that length. This
 * function never re-ranks, because the ranking rule lives in `score.ts` and a second
 * opinion here would be a second answer to the same question.
 */
export function stopoverLengths<T>(
	candidates: readonly T[],
	nightsOf: (candidate: T) => number
): StopoverLength<T>[] {
	const byNights = new Map<number, StopoverLength<T>>();
	for (const candidate of candidates) {
		const nights = nightsOf(candidate);
		const existing = byNights.get(nights);
		if (existing) existing.count += 1;
		else byNights.set(nights, { nights, pick: candidate, count: 1 });
	}
	return [...byNights.values()].sort((a, b) => a.nights - b.nights);
}

/**
 * The length a card opens on: the fewest nights this city can be stopped over in, full
 * stop, zero included.
 *
 * Zero is not a short stopover. It is an ordinary connecting flight: the traveller lands
 * and leaves on the same calendar day and there is no bed to book. The owner made that a
 * rule in issue #225, after this rule was already being written:
 *
 * > there shoudl be no casa in wich the nights could be 0 or more, that case should just
 * > be a flight change and thats it
 *
 * So a connection that can be done same-day IS the same-day connection, and `isFlightChange`
 * below is how the card knows to say so. Skipping the zero to open on a one-night pairing
 * would be the app choosing a stopover for a traveller whose flights never asked for one,
 * the same defect as choosing six, and it would put a bed nobody needs inside the number
 * two cities are compared on.
 *
 * `undefined` only for an empty list, which `group.ts` cannot produce (a group exists
 * because it has variants) and `pipeline.ts` already guards.
 */
export function defaultStopoverLength<T>(
	lengths: readonly StopoverLength<T>[]
): StopoverLength<T> | undefined {
	return lengths[0];
}

/**
 * True when this connection can be flown through without spending a night, so the trip the
 * card opens on is a flight change rather than a stopover.
 *
 * It changes what the card SAYS, not what it offers. Issue #225's rule is about the price:
 * "if the itinerary doesnt need a night, perfect the total price is just the flights
 * price", and a card whose nights start at zero must not fold an optional night into the
 * figure a traveller compares cities on. Opening at zero and calling it a flight change
 * does exactly that.
 *
 * What it must NOT do is delete the longer pairings. This app exists to turn a connection
 * into a trip, and a city with a same-day pairing is usually also a city worth two nights;
 * hiding the ladder there would answer the product's own question with silence for every
 * well-connected stopover. So the control still steps up from zero, and the first night the
 * traveller adds is priced as what it is, an addition they chose.
 */
export function isFlightChange<T>(lengths: readonly StopoverLength<T>[]): boolean {
	return lengths[0]?.nights === 0;
}

/**
 * The length the traveller asked for, or `undefined` when this city cannot do it.
 *
 * Exact rather than nearest, deliberately: "3 nights" resolved to a 5-night pairing is the
 * app choosing the trip again, which is the whole defect. A caller that gets `undefined`
 * falls back to `defaultStopoverLength` and the control never offers the length in the
 * first place.
 */
export function stopoverOfLength<T>(
	lengths: readonly StopoverLength<T>[],
	nights: number
): StopoverLength<T> | undefined {
	return lengths.find((length) => length.nights === nights);
}

/**
 * Convenience for the two call sites that only want the candidate a card opens on and do
 * not need the rest of the ladder: `pipeline.ts`, which spends its one transit-timetable
 * lookup on it, and `group.ts`'s `best`.
 */
export function defaultStopover<T>(
	candidates: readonly T[],
	nightsOf: (candidate: T) => number
): T | undefined {
	return defaultStopoverLength(stopoverLengths(candidates, nightsOf))?.pick;
}
