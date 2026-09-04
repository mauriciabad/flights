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

	// Issue #105: `nights` comes from the flight schedule alone (build.ts's own
	// `nightsBetween`), never from whether a bed got priced, so a real stopover still
	// leads with it even with no stay provider configured — the default state for every
	// first-time visitor. The missing bed is a separate, honest note layered on top,
	// never a reason to hide a real night count behind "no stay priced".
	if (nights >= 1) {
		const nightsLabel = nights === 1 ? '1 night' : `${nights} nights`;
		const stayNote = itinerary.stay ? '' : ' — no bed priced for it yet';
		return `${nightsLabel} in the stopover city, most of it free time${stayNote}.`;
	}
	// Issue #94 added a "No stay priced for this stopover yet" line here for the no-nights,
	// no-stay case. Issue #140 removed it: zero nights means the traveller lands and leaves
	// the same day, so no stay is missing and none is coming. "Yet" promised one. What is
	// actually true about a same-day connection is how much of the day it leaves free,
	// which is what the branches below already say.
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

/**
 * The finest unit `formatAge` resolves, so it is also the only age this badge can call
 * "current" without saying something `formatAge` would immediately contradict in the
 * footer beneath it. Not a policy anyone chose about how long a price stays good — that
 * would be exactly the invented number this whole change exists to remove.
 */
const CURRENT_WITHIN_MS = 60_000;

export function describePriceFreshness(freshness: PriceFreshness): PriceFreshnessDisplay {
	switch (freshness.tier) {
		case 'fresh':
			// A finished search does not make an hour-old cached price current, and since
			// #151 the adapters report that hour honestly. Saying "Current price" over it
			// was the last place the app still preferred a fact about itself (the search
			// finished) to a fact it was handed (when the price was fetched).
			return freshness.ageMs < CURRENT_WITHIN_MS
				? { label: 'Current price', tone: 'neutral' }
				: { label: `Priced ${formatAge(freshness.ageMs)}`, tone: 'neutral' };
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
