/**
 * What one search is allowed to cost, in HTTP requests, per provider.
 *
 * This is the only file that may change these numbers. Raising one is a deliberate act
 * with a price attached, and `cost-per-search.qa.ts` prints that price when it fails:
 * a free tier divided by a per-search cost is how many searches the owner gets before
 * the month is gone.
 *
 * Why a whole search and not a single call: `providers/budget/caps.ts`'s
 * `isQuotaGenerous` already divides a monthly cap by the cost of ONE provider call, and
 * that is exactly how 48 Booking.com requests got waved through against a 50-a-month
 * tier (issue #148). One click is the unit the traveller spends in, so one click is the
 * unit this file budgets in.
 *
 * The numbers below are ceilings, not targets. They are set at what the app should cost
 * once each provider's fan-out is bounded, NOT at what it costs today — a budget copied
 * from current behaviour can only ever ratify it.
 */

import { SETTINGS_PROVIDERS } from '../../src/lib/settings/provider-catalog';
import type { ProviderId } from '../../src/lib/providers/types';

/**
 * Searches the owner must still have left in the month after spending one. Below this,
 * the app is a thing he can use four times and then not at all, which is the state
 * issue #148 reports.
 *
 * 20 matches `MIN_SEARCHES_PER_MONTH_FOR_AUTO_RUN` in `providers/budget/caps.ts` on
 * purpose: same intent, applied to the unit that actually spends.
 */
export const MIN_SEARCHES_PER_MONTH = 20;

/**
 * Maximum HTTP requests one search may send to each provider host.
 *
 * A provider absent from this table is not "unlimited" — `cost-per-search.qa.ts` fails
 * on any host it sees that has no entry here, so adding a provider means declaring what
 * it costs. That is the point: the fan-out that emptied 85% of the Booking.com month was
 * never written down anywhere before it was spent.
 */
export const REQUESTS_PER_SEARCH: Readonly<Record<ProviderId, number>> = {
	// Metered. Each ceiling is at most `monthlyQuota / MIN_SEARCHES_PER_MONTH`, floored —
	// `budgetsThatOutrunTheirFreeTier` below recomputes that rather than trusting these
	// constants, so a ceiling raised past what the month can pay for fails on its own.
	// Kiwi has no settings-page entry yet, so its 300/month (docs/PROVIDERS.md) is not
	// checked that way; 12 keeps it under the same floor by hand until it has one.
	skyscanner: 1,
	'flights-sky': 2,
	kiwi: 12,
	booking: 2,
	agoda: 25,

	// Keyless (issue #157), and the only flight source on a route Ryanair does not fly, so
	// its fan-out is the one to watch: one call per leg per candidate plus a route-graph
	// lookup is the shape a bounded implementation has. Measured at 46 today against
	// Ryanair's 11 for the same question, which is issue #165.
	'kiwi-public': 30,

	// Keyless, so no money at stake, but not free either: Ryanair rate-limits, and one
	// search issuing 96 requests to it (issue #121, measured) is how a keyless provider
	// starts returning 429s mid-search. A ceiling here is a politeness limit, set at what
	// a bounded implementation needs — one fare call per leg per candidate, plus the
	// route graph and the airport table once each.
	ryanair: 30,
	osrm: 30,
	transitous: 20,
	'transitous-geocode': 10,

	// Build-time only: `cheap-routes.generated.json` ships as a static asset, so a search
	// that reaches Travelpayouts over the network has broken the no-backend rule.
	'travelpayouts-cheap-routes': 0
};

/**
 * Hosts that belong to no provider adapter and carry no quota, so a request to one is not a
 * budget failure. They are still answered from a stub and still counted, because a request
 * nobody expected is worth seeing even when it is free.
 *
 * `nominatim.openstreetmap.org` is Agoda's reverse-geocode step (`agoda.ts` excludes it from
 * its own cost estimate for the same reason). `basemaps.cartocdn.com` is the map style the
 * itinerary detail view loads. Adding a host here is a statement that it costs nothing —
 * if that is not true, it belongs in `REQUESTS_PER_SEARCH` instead.
 */
export const UNBUDGETED_HOSTS: readonly string[] = ['nominatim.openstreetmap.org', 'basemaps.cartocdn.com'];

export interface BudgetVerdict {
	providerId: ProviderId;
	observed: number;
	budget: number;
	monthlyFreeTier?: number;
	/** Searches the free tier buys at the observed rate. `undefined` for a keyless
	 * provider, which has no monthly tier to divide. */
	searchesPerMonth?: number;
}

function monthlyFreeTierFor(providerId: ProviderId): number | undefined {
	return SETTINGS_PROVIDERS.find((entry) => entry.id === providerId)?.monthlyQuota;
}

/** Turns a raw per-provider request count into the verdict `cost-per-search.qa.ts`
 * reports, so the arithmetic that makes a number bad lives next to the number itself. */
export function judge(providerId: ProviderId, observed: number): BudgetVerdict {
	const monthlyFreeTier = monthlyFreeTierFor(providerId);
	return {
		providerId,
		observed,
		budget: REQUESTS_PER_SEARCH[providerId],
		monthlyFreeTier,
		searchesPerMonth: monthlyFreeTier === undefined ? undefined : Math.floor(monthlyFreeTier / Math.max(1, observed))
	};
}

export function describeVerdict(verdict: BudgetVerdict): string {
	const { providerId, observed, budget, monthlyFreeTier, searchesPerMonth } = verdict;
	const head = `${providerId}: one search sent ${observed} requests, budget is ${budget}`;
	if (monthlyFreeTier === undefined) return `${head} (keyless, so this is a rate-limit ceiling, not money)`;
	return `${head}. At ${observed} a search, the ${monthlyFreeTier}/month free tier buys ${searchesPerMonth} searches — the floor is ${MIN_SEARCHES_PER_MONTH}.`;
}

/**
 * The budget table has to be self-consistent: a metered provider's ceiling must itself
 * leave `MIN_SEARCHES_PER_MONTH` searches in the free tier. Checked as its own invariant
 * (`cost-per-search.qa.ts`) so nobody can quietly fix a failing search by raising the
 * ceiling past the point where the month survives.
 */
export function budgetsThatOutrunTheirFreeTier(): string[] {
	const problems: string[] = [];
	for (const entry of SETTINGS_PROVIDERS) {
		const budget = REQUESTS_PER_SEARCH[entry.id];
		if (budget === undefined || budget === 0) continue;
		const searches = Math.floor(entry.monthlyQuota / budget);
		if (searches < MIN_SEARCHES_PER_MONTH) {
			problems.push(
				`${entry.id}: budget of ${budget} requests a search against a ${entry.monthlyQuota}/month tier is ${searches} searches, below the floor of ${MIN_SEARCHES_PER_MONTH}`
			);
		}
	}
	return problems;
}
