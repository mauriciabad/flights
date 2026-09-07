/**
 * The three rules the heart on a result card runs on, issue #434.
 *
 * They live here rather than inside `ResultCard.svelte` and `+page.svelte` because each one
 * is a decision somebody will want to argue with, and a decision inlined in a component is
 * a decision no test can reach. The store, the snapshot and the visit token are all tested
 * next door in `$lib/saved`; these are the three questions the results screen asks on top
 * of them.
 */

import { priceTrend, trendNote } from '$lib/saved';
import type { SavedItinerary, TrendNote } from '$lib/saved';
import type { PriceFreshness } from './types';

export interface SaveTripPlaces {
	origin: string;
	connection: string;
	destination: string;
}

/**
 * What the heart is called, out loud, in each of its two states.
 *
 * The name changes with the state and does not lean on `aria-pressed`. A voice-control user
 * says the name of the control they want, so a toggle whose name is "Save this trip" in both
 * states can be pressed but never released, and one called "Save this trip" on six cards at
 * once cannot be aimed at all. The route is in the name for the same reason: it is the only
 * thing that tells six identical hearts apart.
 */
export function saveTripLabel(saved: boolean, places: SaveTripPlaces): string {
	const route = `${places.origin} to ${places.destination} via ${places.connection}`;
	return saved ? `Remove ${route} from saved trips` : `Save ${route}`;
}

/**
 * Whether this card's price is the search's final word for this visit, and so worth filing.
 *
 * `stale` means the pipeline is still running and this total is missing whatever has not
 * answered yet, most often the bed. A row written then reads as a trip that cost 96 euros on
 * Tuesday and 160 on Wednesday, and the chart it draws is a lie about the fare rather than a
 * fact about a half-finished search. `expired-fallback` is the other refusal: a provider
 * behind this price is failing and the app is showing an expired copy, which is a price
 * nobody quoted today.
 *
 * So `fresh` is the whole rule, and the pipeline already computes it (`results/types.ts`,
 * `buildProvenance`). A second predicate over `primarySearchDone && !stillSearching` would
 * be the same question asked in a spelling that can drift from the badge on screen.
 */
export function priceIsSettled(freshness: PriceFreshness): boolean {
	return freshness.tier === 'fresh';
}

/**
 * The one line a saved card gets about its own price history, or nothing.
 *
 * Two observations is the floor, because one is "the price when you saved it" and comparing
 * that against itself says nothing. `trendNote` already refuses the comparison across two
 * currencies, so a card that was saved in euros and is priced in pounds says so instead of
 * subtracting.
 *
 * The short form, never the long one. The card has a height budget (`card-size.spec.ts`) and
 * this line is spending it.
 */
export function savedPriceNote(entry: SavedItinerary | undefined): TrendNote | undefined {
	if (!entry || entry.prices.length < 2) return undefined;
	return trendNote(priceTrend(entry.prices));
}
