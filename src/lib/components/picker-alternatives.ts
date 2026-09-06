/**
 * Issue #140: whether the pickers under an expanded result card actually offer a choice.
 *
 * The detail view opened with "Trying an alternative below previews this trip. It does not
 * change your saved results." on every card, including the ordinary free-tier case where
 * one flight came back per leg, no transport options and no stays. There was nothing to
 * try, and the sentence described an interaction the screen did not have.
 *
 * Answering that needs the same dedupe the pickers themselves apply, or the hint and the
 * list underneath it can disagree: `FlightPicker` collapses two rows carrying the same
 * carrier, number and departure into one, so counting the raw array would claim a choice
 * that renders as a single "Current pick" row. Hence `flightKey` lives here and
 * `FlightPicker` imports it rather than keeping its own copy. Since issue #387 the
 * definition itself lives in `algorithm/pairings.ts`, because the pairing search needs the
 * same identity and `algorithm/` may not import from `components/`.
 */

import type { FlightOffer } from '../domain';
import { flightKey } from '../algorithm/pairings';

/**
 * One flight's identity for picker purposes: the same physical departure offered twice by
 * two providers is one row, not two.
 *
 * Issue #387 moved the definition to `algorithm/pairings.ts` and left this re-export, for
 * the reason the header above gives: the picker's dedupe and the pairing search now have to
 * agree on when two offers are the same flight, and the pairing search cannot import a
 * component module. Every existing caller keeps importing it from here.
 */
export { flightKey };

/** How many rows `FlightPicker` would actually draw for this pool. */
export function distinctFlightCount(flights: readonly FlightOffer[]): number {
	return new Set(flights.map(flightKey)).size;
}

/**
 * True when at least one picker below the timeline has more than one thing to pick.
 *
 * A stay list counts from one property, not two: with no stay currently on the itinerary,
 * a single property on offer is still a real choice (price it in, or leave it out), which
 * is not true of a flight leg that already has its only option selected.
 */
export function hasSwappableAlternatives(input: {
	outboundFlights: readonly FlightOffer[];
	onwardFlights: readonly FlightOffer[];
	/** `TransferLegOptions.candidates.length` for each of the four transfer legs. */
	transferCandidateCounts: readonly number[];
	stayPropertyCount: number;
}): boolean {
	return (
		distinctFlightCount(input.outboundFlights) > 1 ||
		distinctFlightCount(input.onwardFlights) > 1 ||
		input.transferCandidateCounts.some((count) => count > 1) ||
		input.stayPropertyCount > 0
	);
}
