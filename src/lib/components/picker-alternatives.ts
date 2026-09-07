/**
 * How many rows a picker would actually draw, which is not how many the search returned.
 *
 * Issue #140 built this to answer whether the pickers under an expanded result card offered
 * a choice at all: the detail view opened with "Trying an alternative below previews this
 * trip" on every card, including the ordinary free-tier case with one flight per leg and no
 * stays. That sentence is gone with the fold that carried it (issue #440), and
 * `hasSwappableAlternatives` went with it. What is left is the count itself, which
 * `option-marks.ts` uses to decide whether a timeline row promises a choice.
 *
 * Answering that needs the same dedupe the pickers themselves apply, or a mark and the list
 * underneath it can disagree: `FlightPicker` collapses two rows carrying the same
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
