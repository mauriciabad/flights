/**
 * Pure derivations from a ScoredResult that ResultCard.svelte renders directly, kept out
 * of the component so the reasoning behind "why this is good" and how a price's age reads
 * to a traveller is unit-testable without mounting Svelte (this repo has no
 * @testing-library/svelte; AGENTS.md still asks for tests on "anything with logic in it,"
 * which this module is and the component around it deliberately is not).
 */

import { usableFreeHours } from '$lib/algorithm/score';
import { formatAge } from './format';
import type { PriceFreshness, ScoredResult } from './types';

/**
 * The brief's "a one-line why this is good," grounded in the same breakdown
 * `algorithm/score.ts` computed rather than a separate, possibly-contradictory heuristic.
 * Checked in the order that matches DEFAULT_SCORING_WEIGHTS' own priority (nights is by
 * far the largest weight, so it leads when present), never invents a number the score
 * breakdown doesn't already contain.
 */
export function describeWhyGood(result: ScoredResult): string {
	const { itinerary, score } = result;
	const nights = itinerary.nightsInConnection;
	const usableHours = Math.round(usableFreeHours(itinerary.freeTime));

	// Issue #94: with no stay priced, `nights` is always 0 by convention, not because the
	// layover is genuinely a day trip — say that plainly rather than let a "no overnight
	// stay needed" line below imply a fact nobody checked.
	if (!itinerary.stay) {
		return 'No stay priced for this stopover yet — showing flights and free time only.';
	}
	if (nights >= 1) {
		const nightsLabel = nights === 1 ? '1 night' : `${nights} nights`;
		return `${nightsLabel} in the stopover city, most of it free time.`;
	}
	if (usableHours >= 4) {
		return `About ${usableHours}h free in the stopover during the day, no overnight stay needed.`;
	}
	if (score.avoidedAirlineFlightCount > 0) {
		return 'The cheapest option here, on an airline you asked to avoid.';
	}
	if (score.breakdown.airportWaiting > score.breakdown.travelTime) {
		return 'A quick connection with little time stuck waiting at either airport.';
	}
	return 'A straightforward connection with no long layover either way.';
}

/** "+2 more flight times through here", brief line 67: "user can see alternative
 * flights for same location with their price and difference from selected one." Picking
 * a specific alternate and swapping it in is the comparator's job (issue #25); this list
 * only says how many exist. `undefined` when there is nothing but the headline card. */
export function describeVariants(result: ScoredResult): string | undefined {
	const extra = result.variantCount - 1;
	if (extra <= 0) return undefined;
	return `+${extra} more flight time${extra === 1 ? '' : 's'} through here`;
}

/** Short label plus a semantic tone for the price badge, so ResultCard only has to pick a
 * CSS class from `tone` rather than re-deriving one from the freshness union itself. */
export interface PriceFreshnessDisplay {
	label: string;
	tone: 'neutral' | 'info' | 'warning';
}

export function describePriceFreshness(freshness: PriceFreshness): PriceFreshnessDisplay {
	switch (freshness.tier) {
		case 'fresh':
			return { label: 'Current price', tone: 'neutral' };
		case 'stale':
			// The search itself is still running (SearchSnapshot.done is false), this
			// number is real, just not yet the pipeline's final word on it.
			return { label: 'Still confirming…', tone: 'info' };
		case 'expired-fallback':
			return {
				label: `Priced ${formatAge(freshness.ageMs)}. ${freshness.message}`,
				tone: 'warning'
			};
	}
}
