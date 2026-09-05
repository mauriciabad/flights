/**
 * Issue #232: reading the price history a band is built from. Zero requests, always.
 *
 * Everything here comes out of what the browser already holds. `collectLegFares`
 * (`flexible-dates/collect.ts`) merges two free sources: the ledger #200 writes as results
 * stream past, and the Ryanair month grids ordinary searches already cached. Neither costs
 * anything to read, and this module never calls the fetching half of that module, so
 * opening a results page cannot spend a request on this feature.
 *
 * That also settles the cold-start question the issue poses. A first-time visitor's ledger
 * holds only the week they just searched, `buildPriceBand` counts fewer than fourteen
 * priced departure dates, and the card shows nothing. There is no button here offering to
 * fill the year: `/results/when/` already owns that offer, states its cost before it is
 * pressed, and is the screen a traveller is on when they want price history. Repeating it
 * on eight result cards would be the "announced seven times on one screen" mistake issue
 * #185 was opened to undo.
 *
 * ## The window
 *
 * The departure month either side of the search's own. Wide enough that fourteen priced
 * days is reachable from a couple of ordinary searches, narrow enough that a January fare
 * is never evidence about a July one. The band prints the range it actually covers, so a
 * reader is never guessing which months are in it.
 */

import type { CacheStore } from '$lib/cache';
import type { IataAirportCode, IsoCurrencyCode, SearchQuery } from '$lib/domain';
import { addDays, collectLegFares, daysBetween, monthStartsBetween } from '$lib/flexible-dates';
import { buildPriceBand } from './price-band';
import type { PriceBand, StopoverLegFares } from './price-band';

/** Days either side of the search window whose months the band may draw on. Thirty-one
 * guarantees the neighbouring month is included whatever day of the month the search
 * starts on. */
const NEIGHBOURING_DAYS = 31;

export interface PriceBandRequest {
	query: SearchQuery;
	/** Every stopover the current search turned up. The band pools all of them, because the
	 * traveller's question is about the origin and the destination and the stopover is the
	 * variable (see `price-band.ts`'s header). */
	stopovers: readonly IataAirportCode[];
	currency: IsoCurrencyCode;
}

/**
 * How many nights the band's trips may spend in the stopover.
 *
 * The search's own span, from zero. Zero is deliberate: this app does return same-day
 * flight changes, and a band that excluded them would rank a flight-change card against a
 * set that contains nothing shaped like it.
 */
function nightRange(query: SearchQuery): { minNights: number; maxNights: number } {
	const span = daysBetween(query.soonestDeparture, query.latestArrival);
	return { minNights: 0, maxNights: Math.max(0, span ?? 0) };
}

/** The band for one search, read straight out of the cache. Never throws and never
 * fetches: a results page that has already rendered must not be taken down, or slowed
 * down, by a figure that only adds context to it. */
export async function collectPriceBand(
	request: PriceBandRequest,
	options: { store?: CacheStore; now?: number } = {}
): Promise<PriceBand> {
	const { query, stopovers, currency } = request;
	const months = monthStartsBetween(
		addDays(query.soonestDeparture, -NEIGHBOURING_DAYS),
		addDays(query.latestArrival, NEIGHBOURING_DAYS)
	);

	const legsByStopover: StopoverLegFares[] = [];
	for (const via of stopovers) {
		const [outbound, onward] = await Promise.all([
			collectLegFares({ origin: query.originAirport, destination: via, currency }, months, options),
			collectLegFares({ origin: via, destination: query.destinationAirport, currency }, months, options)
		]);
		legsByStopover.push({ via, outbound: outbound.fares, onward: onward.fares });
	}

	return buildPriceBand(legsByStopover, { currency, ...nightRange(query) });
}
