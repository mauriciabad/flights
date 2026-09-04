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

/** "+2 more flight times", brief line 67: "user can see alternative flights for same
 * location with their price and difference from selected one." Picking a specific
 * alternate and swapping it in is `FlightPicker`'s job in the expanded card detail; this
 * list only says how many exist. `undefined` when there is nothing but the headline card.
 *
 * No "through here" on the end: the card is about one connection, so the words carried
 * nothing, and at 375px they were what pushed "Show details" onto a line of its own. */
export function describeVariants(result: ScoredResult): string | undefined {
	const extra = result.variantCount - 1;
	if (extra <= 0) return undefined;
	return `+${extra} more flight time${extra === 1 ? '' : 's'}`;
}

/** Short label plus a semantic tone for the price badge, so ResultCard only has to pick a
 * CSS class from `tone` rather than re-deriving one from the freshness union itself. */
export interface PriceFreshnessDisplay {
	label: string;
	tone: 'neutral' | 'info' | 'warning';
}

/**
 * The finest unit `formatAge` resolves, so it is also the only age this badge can call
 * "just checked" without saying something `formatAge` would immediately contradict in the
 * footer beneath it. Not a policy anyone chose about how long a price stays good — that
 * would be exactly the invented number this whole change exists to remove.
 */
const CURRENT_WITHIN_MS = 60_000;

/**
 * Issue #170: every label here says when WE last checked, and none of them says when the
 * price was set.
 *
 * The words used to be "Current price" and "Priced 40 minutes ago". Both are claims about
 * the fare itself, and both were built from `retrievedAgeMs`, which only knows when this
 * app's HTTP client last ran. A fare retrieved 40 minutes ago may have been repriced
 * eight hours before that, and nothing in this app can tell the difference: no adapter
 * has a provider that reports its own repricing instant (measured 2026-09-04, see
 * `providers/flights/ryanair-types.ts`). "Checked" is a fact about us, and it is the only
 * kind of fact this number can support.
 *
 * That is a smaller claim than "Current price", deliberately. AGENTS.md: say what you do
 * not know rather than guessing, and never present an estimate as a fact.
 */
export function describePriceFreshness(freshness: PriceFreshness): PriceFreshnessDisplay {
	switch (freshness.tier) {
		case 'fresh':
			// A finished search does not make an hour-old cached price current, and since
			// #151 the adapters report that hour honestly. Saying "Current price" over it
			// was the last place the app still preferred a fact about itself (the search
			// finished) to a fact it was handed (when the price was retrieved).
			return freshness.retrievedAgeMs < CURRENT_WITHIN_MS
				? { label: 'Just checked', tone: 'neutral' }
				: { label: `Checked ${formatAge(freshness.retrievedAgeMs)}`, tone: 'neutral' };
		case 'stale':
			// The search itself is still running (SearchSnapshot.done is false), this
			// number is real, just not yet the pipeline's final word on it.
			return { label: 'Still confirming…', tone: 'info' };
		case 'expired-fallback':
			return {
				label: `Checked ${formatAge(freshness.retrievedAgeMs)}. ${freshness.message}`,
				tone: 'warning'
			};
	}
}
