/**
 * The compact trip strip: three spans of an itinerary, sized roughly to how long each one
 * really takes.
 *
 * The results list needed a preview of the timeline that reads at a glance instead of a
 * text list, and the answer to "what shape is this trip" is not the ten-row schedule, it
 * is the three spans a traveller actually weighs against each other: the flight out, the
 * time in the stopover city, the flight on. Everything else on the itinerary happens
 * inside one of those three.
 *
 * The arithmetic lives here rather than in the component so the proportions are testable
 * without mounting Svelte, and so every screen that wants to show the shape of a trip
 * draws the same bar from the same numbers.
 *
 * ## Why proportional, and why not exactly proportional
 *
 * The point of the strip is that a 3-night stopover looks nothing like a 2-hour one, so
 * the spans have to carry magnitude spatially. But a real trip runs to ratios like 2 hours
 * against 72, and at 375px a raw 1:36 split renders a flight as a 4px sliver: technically
 * proportional, useless as a picture, and impossible to label. So each span gets a floor
 * (`MIN_SHARE`) and the rest is redistributed. Between two itineraries the longer stopover
 * is still visibly the longer one, which is the comparison the strip exists to serve;
 * what is given up is reading an exact ratio off the pixels, which nobody does anyway and
 * which the printed durations beside the bar answer exactly.
 */

import type { Itinerary } from '$lib/domain';
import { minutesBetween } from '$lib/algorithm/build';

/**
 * The share of the bar every span is guaranteed regardless of its length. 0.10 of a 335px
 * bar (a 375px phone, minus the card's own padding) is about 33px, wide enough to hold a
 * carrier's mark and stay a recognisable band.
 */
export const MIN_SHARE = 0.1;

export interface TripStripSpan {
	kind: 'flight' | 'stopover';
	/** Real elapsed minutes this span covers. Printed as text beside the bar, so the
	 * clamped `share` below never has to be read as a measurement. */
	minutes: number;
	/** Fraction of the bar's width, floored at `MIN_SHARE` and renormalised so the three
	 * of them still sum to 1. */
	share: number;
	/** IATA codes at this span's two ends. */
	from: string;
	to: string;
}

export interface TripStrip {
	spans: [TripStripSpan, TripStripSpan, TripStripSpan];
	/** Airport-to-airport, the span the bar actually covers. Not `times.total`, which also
	 * counts the ground legs at either end that this strip deliberately does not draw. */
	totalMinutes: number;
}

/**
 * Distributes `1` across the given weights: `MIN_SHARE` to each as a baseline, then the
 * remainder in proportion.
 *
 * The obvious alternative, clamping anything under the floor up to it and renormalising
 * the rest, has a failure this does not: when two spans are both under the floor they
 * both land on it exactly, so a two-hour flight and a three-hour flight become the same
 * width. That is the common case here, not an edge one, since a multi-night stopover puts
 * both flights under any floor worth having. A baseline plus a proportional remainder is
 * strictly order-preserving: a longer span is always a wider band.
 *
 * Exported for its own tests. The invariants worth pinning down (sums to 1, nothing below
 * the floor, order preserved) are properties of this function, not of any component.
 */
export function clampedShares(weights: readonly number[]): number[] {
	if (weights.length === 0) return [];
	const safe = weights.map((weight) => Math.max(weight, 0));
	// A floor of 0.1 needs at most 10 spans to exhaust the bar; this app draws 3. The cap
	// is here so the function is total rather than because anything calls it that way.
	const floor = Math.min(MIN_SHARE, 1 / safe.length);
	const total = safe.reduce((sum, weight) => sum + weight, 0);
	// A degenerate itinerary with no measurable time in it: an equal split is the only
	// honest picture.
	if (total <= 0) return safe.map(() => 1 / safe.length);

	const remainder = 1 - floor * safe.length;
	return safe.map((weight) => floor + (weight / total) * remainder);
}

/**
 * The three spans, in order, with their real durations and their bar widths.
 *
 * The stopover's length is measured between the two flights' own clocks rather than
 * summed out of `freeTime`, `connectionWaitingTime` and the two ground transfers. Those
 * parts do add up to the same number, but only when every one of them is present, and a
 * stopover with no priced bed has no transfers at all (`search/resources.ts` never looks
 * them up). `minutesBetween` is DST-correct and always available, since both flights
 * always are.
 */
export function tripStrip(itinerary: Itinerary): TripStrip {
	const { outboundFlight, onwardFlight } = itinerary;
	const stopoverMinutes = Math.max(0, minutesBetween(outboundFlight.arrival, onwardFlight.departure));
	const minutes = [outboundFlight.duration, stopoverMinutes, onwardFlight.duration];
	const shares = clampedShares(minutes);

	return {
		totalMinutes: minutes[0]! + minutes[1]! + minutes[2]!,
		spans: [
			{
				kind: 'flight',
				minutes: minutes[0]!,
				share: shares[0]!,
				from: outboundFlight.departureAirport,
				to: outboundFlight.arrivalAirport
			},
			{
				kind: 'stopover',
				minutes: minutes[1]!,
				share: shares[1]!,
				from: outboundFlight.arrivalAirport,
				to: onwardFlight.departureAirport
			},
			{
				kind: 'flight',
				minutes: minutes[2]!,
				share: shares[2]!,
				from: onwardFlight.departureAirport,
				to: onwardFlight.arrivalAirport
			}
		]
	};
}
