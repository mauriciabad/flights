/**
 * Pure derivations from a ScoredResult that ResultCard.svelte renders directly, kept out
 * of the component so how a price's age reads to a traveller is unit-testable without
 * mounting Svelte (this repo has no @testing-library/svelte; AGENTS.md still asks for
 * tests on "anything with logic in it," which this module is and the component around it
 * deliberately is not).
 *
 * `describeWhyGood` used to live here too: one sentence per card, picked from a ladder of
 * conditions, saying things like "3 nights in the stopover city, most of it free time."
 * It is gone because the card now prints the night count and the free time as numbers, in
 * their own cells, next to the trip strip that shows the same fact as a shape. A sentence
 * restating two numbers that are already on screen is a row that carries nothing, and the
 * one thing it said that no number carries, "on an airline you asked to avoid", is now a
 * marker on the card itself rather than the fifth branch of a paragraph.
 */

import { formatAge } from '$lib/format';
import type { PriceFreshness, ScoredResult } from './types';

/** "+2 more flight times through here", brief line 67: "user can see alternative
 * flights for same location with their price and difference from selected one." Picking
 * a specific alternate and swapping it in is `FlightPicker`'s job in the expanded card
 * detail; this list only says how many exist. `undefined` when there is nothing but the
 * headline card. */
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
