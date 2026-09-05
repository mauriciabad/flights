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
import type { PriceFreshness, ProvenancePart, ScoredResult } from './types';

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

/**
 * The card's footer sentence: which providers are behind this price, and when each of them
 * was last retrieved.
 *
 * Issue #289. This used to be `Math.min` over every part, printed once as "fetched N ago".
 * The sources on one card do not share a TTL and never will: Kiwi offers last 15 minutes
 * and Ryanair fares an hour, while a Hostelworld bed and an OSRM road route are both cached
 * for 30 days, because a road does not move. So the oldest TTL on the card won the sentence.
 * Measured with `tools/probe-card-age.mjs` on a warm reload: 76 provider responses landed
 * inside three seconds, every flight and bed entry came back 0 minutes old, and the footer
 * read "fetched 3 hours ago" about a road route nothing had any reason to refetch. That
 * number could only ever get worse, so a traveller was being told to distrust a fare this
 * app had retrieved a minute earlier, and a genuinely stale bed looked exactly the same.
 *
 * The rule now is that a printed age names the sources it is actually about. Sources are
 * grouped by the age they format to, freshest group first, and each group carries its own
 * "fetched". One group is the ordinary case, a search whose parts all landed together, and
 * it produces the same single-age sentence as before.
 *
 * Freshest first so that the price's own age is what a reader reaches first and the road
 * route is what trails off. That buys less than it sounds like: measured at 375px, this row
 * shows about a tenth of its own text whatever it says, and the `title` is what carries the
 * sentence on a phone. It is worth having on a card wide enough to read the line, and it
 * costs nothing.
 *
 * A provider is named once, at the age of the oldest part it supplied. Kiwi answering for
 * one leg out of cache and refetching the other is one source that is as fresh as its worst
 * contribution, not two Kiwis on the same card.
 *
 * `now` is a parameter rather than a `Date.now()` call so this is testable, which is the
 * whole reason it lives here and not in the component. The bug shipped inside `ResultCard`,
 * where nothing could reach it.
 */
export function describeSources(parts: readonly ProvenancePart[], now: number): string | undefined {
	if (parts.length === 0) return undefined;

	const oldestByLabel = new Map<string, number>();
	for (const part of parts) {
		const fetchedAt = new Date(part.fetchedAt).getTime();
		const seen = oldestByLabel.get(part.providerLabel);
		if (seen === undefined || fetchedAt < seen) oldestByLabel.set(part.providerLabel, fetchedAt);
	}

	const byAge = new Map<string, { labels: string[]; fetchedAt: number }>();
	for (const [label, fetchedAt] of oldestByLabel) {
		const age = formatAge(Math.max(0, now - fetchedAt));
		const group = byAge.get(age);
		if (group === undefined) byAge.set(age, { labels: [label], fetchedAt });
		else {
			group.labels.push(label);
			group.fetchedAt = Math.min(group.fetchedAt, fetchedAt);
		}
	}

	return [...byAge]
		.sort(([, a], [, b]) => b.fetchedAt - a.fetchedAt)
		.map(([age, group], index) => `${index === 0 ? 'via ' : ''}${group.labels.join(' & ')}, fetched ${age}`)
		.join('; ');
}
