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
 *   why." `describeStopoverChange` is that sentence, and it names which flight moved rather
 *   than only that something did.
 * - "then we simply show +x€per night" (#225). `describeNextLength` is that figure, and it
 *   is computed from the two real pairings rather than from the bed's nightly rate: a
 *   longer stay usually means a different onward fare, and quoting EUR 22 for a night that
 *   actually costs EUR 41 once the fare moves would be an invented number on a card whose
 *   whole job is to be trusted.
 */

import type { FlightOffer, Itinerary } from '$lib/domain';
import { formatMoney, formatMoneyDelta } from '$lib/format';

/** "Flight change", "1 night", "3 nights". The one string the control's value and every
 * label built from it read, so they can never disagree about what zero means. */
export function stopoverLengthLabel(nights: number): string {
	if (nights <= 0) return 'Flight change';
	return `${nights} ${nights === 1 ? 'night' : 'nights'}`;
}

/** Which flights a longer stopover had to reach for. Both change when a city's next
 * length up comes from a different day's outbound as well as a later onward. */
export type ChangedFlights = 'none' | 'outbound' | 'onward' | 'both';

export interface StopoverChange {
	/** Nights added relative to the shortest stopover this city can do. Zero while the
	 * card is at its default, which is the state most cards are in. */
	extraNights: number;
	/** Total price at the shown length minus the total at the shortest one, in minor
	 * units of the shared currency. Signed: a later onward flight is sometimes a cheaper
	 * fare, and a longer stay that costs less is a fact worth showing, not one to hide
	 * behind an assumed "+". */
	deltaMinorUnits: number;
	currency: string;
	changedFlights: ChangedFlights;
	/** One line for the card: what the extension did to the price and which flight moved
	 * to allow it. `undefined` at the default length, where there is no change to report
	 * and a line saying "same price" would be noise on every card in the list. */
	note?: string;
}

/**
 * Whether two offers describe the same flight, by what identifies a flight rather than by
 * object identity: carrier, number, and the wall-clock departure that separates today's
 * FR3143 from tomorrow's.
 *
 * Object identity would be simpler and is wrong here. `build.ts` does pass provider offers
 * through by reference, but these two itineraries reach this function through a Svelte
 * `$state` array, and Svelte 5 deep-proxies state: the same underlying offer read through
 * `result.itinerary` and through `result.stopover.minimumItinerary` comes back as two
 * different proxies. Measured on production for BVC to PFO, that printed "Same price, on
 * different flights both ways" under every card's nights control, on trips where nothing
 * had changed at all.
 */
function sameFlight(a: FlightOffer, b: FlightOffer): boolean {
	return (
		a.carrier.iataCode === b.carrier.iataCode &&
		a.flightNumber === b.flightNumber &&
		a.departure.local === b.departure.local
	);
}

function flightsChanged(shown: Itinerary, minimum: Itinerary): ChangedFlights {
	const outbound = !sameFlight(shown.outboundFlight, minimum.outboundFlight);
	const onward = !sameFlight(shown.onwardFlight, minimum.onwardFlight);
	if (outbound && onward) return 'both';
	if (outbound) return 'outbound';
	if (onward) return 'onward';
	return 'none';
}

const CHANGED_FLIGHT_PHRASE: Record<Exclude<ChangedFlights, 'none'>, string> = {
	outbound: 'a different outbound flight',
	onward: 'a different onward flight',
	both: 'different flights both ways'
};

/**
 * What moved between the card's default length and the one on screen.
 *
 * The comparison is against the SHORTEST stopover, not against the previous press of the
 * + button: that is the trip the card offered and the price the traveller compared against
 * the other cities, so it is the only baseline a delta means anything against.
 *
 * Both itineraries come from the same search and the same connection, so they share a
 * currency by construction. `buildItineraries` refuses to total a mix, so a candidate
 * whose parts disagreed never became a variant at all.
 */
export function describeStopoverChange(shown: Itinerary, minimum: Itinerary): StopoverChange {
	const extraNights = shown.nightsInConnection - minimum.nightsInConnection;
	const deltaMinorUnits = shown.totalPrice.minorUnits - minimum.totalPrice.minorUnits;
	const currency = shown.totalPrice.currency;
	const changedFlights = flightsChanged(shown, minimum);

	if (shown === minimum || (extraNights === 0 && changedFlights === 'none')) {
		return { extraNights, deltaMinorUnits: 0, currency, changedFlights: 'none' };
	}

	// "vs 1 night", or "vs the same-day flights" when the baseline has no night in it:
	// "vs flight change" reads as a fee rather than as the trip it is comparing against.
	const baseline =
		minimum.nightsInConnection <= 0
			? 'the same-day flights'
			: stopoverLengthLabel(minimum.nightsInConnection);
	const priceWords =
		deltaMinorUnits === 0 ? 'Same price' : `${formatMoneyDelta(deltaMinorUnits, currency)} vs ${baseline}`;
	const note =
		changedFlights === 'none'
			? priceWords
			: `${priceWords}, on ${CHANGED_FLIGHT_PHRASE[changedFlights]}`;

	return { extraNights, deltaMinorUnits, currency, changedFlights, note };
}

/**
 * Issue #225: "then we simply show +x€per night". What one step along this city's ladder
 * does, in the traveller's own currency, for the button that would take it.
 *
 * Derived from the two pairings' real totals, never from the bed's nightly rate. Those are
 * different numbers whenever a longer stay needs a later onward flight, which is the normal
 * case, and the fare change belongs in the figure a person decides on. When a step moves
 * several nights at once, in a city with a 1-night and a 3-night pairing and nothing
 * between, the per-night figure is the honest way to compare it against a step that
 * moves one.
 *
 * Works in both directions, so the two buttons of a stepper describe themselves with one
 * function rather than one each that could drift apart. `undefined` when the two are the
 * same length, which is not a step.
 */
export function describeLengthStep(from: Itinerary, to: Itinerary | undefined): string | undefined {
	if (!to) return undefined;
	const nightsDelta = to.nightsInConnection - from.nightsInConnection;
	if (nightsDelta === 0) return undefined;
	const delta = to.totalPrice.minorUnits - from.totalPrice.minorUnits;
	const currency = to.totalPrice.currency;
	const price = delta === 0 ? 'same price' : formatMoneyDelta(delta, currency);
	const moved = Math.abs(nightsDelta);
	if (moved === 1) {
		return `${nightsDelta > 0 ? 'one more night' : 'one night fewer'}, ${price}`;
	}
	// Rounded to the currency's own minor unit rather than carried at full precision: this
	// is a rate read off two totals, and printing a third decimal would claim the split
	// between the nights is known when only their sum is.
	const perNight = Math.round(Math.abs(delta) / moved);
	const nights = `${moved} ${nightsDelta > 0 ? 'more nights' : 'nights fewer'}`;
	return `${nights}, ${price} (${formatMoney({ minorUnits: perNight, currency })} a night)`;
}

/**
 * The next length up and the next length down, or `undefined` at either end of what this
 * city offers. A control renders a disabled button rather than hiding one, so the ladder's
 * ends are visible instead of the buttons moving as the traveller steps along it.
 */
export function neighbouringLengths(
	available: readonly number[],
	nights: number
): { shorter?: number; longer?: number } {
	// `available` arrives ascending from `stopoverLengths`; this never re-sorts it, so a
	// caller that hands over something else gets its own order back rather than a silently
	// corrected one.
	let shorter: number | undefined;
	let longer: number | undefined;
	for (const candidate of available) {
		if (candidate < nights) shorter = candidate;
		else if (candidate > nights && longer === undefined) longer = candidate;
	}
	return { shorter, longer };
}
