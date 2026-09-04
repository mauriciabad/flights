/**
 * Issue #148: one search's ration of stay lookups, shared by every connection candidate in
 * that search.
 *
 * The defect this exists to close: `pipeline.ts` calls `fetchConnectionResources` once per
 * connection candidate, and each of those called every keyed stay provider. Nothing anywhere
 * knew what a whole search cost. Six candidates ordinarily, twenty-four on the fallback
 * sweep, times Booking's two requests per lookup, is 12 to 48 requests from one click
 * against a fifty-a-month free tier. The owner's month was gone in a morning.
 *
 * A per-provider monthly cap (`caps.ts`, `quota.ts`) cannot fix that on its own for two
 * reasons. It only stops the bleeding after a large slice is already spent — Booking's cap
 * of 40 would cut in partway through the second fallback-path search, having spent 80% of
 * the month. And it lives in `localStorage` while the quota belongs to the RapidAPI key, so
 * a second browser profile starts again at zero believing it has the full allowance
 * (AGENTS.md, "The owner's quota is real money he told us he would not spend"). A bound
 * per search is the one that holds across both.
 *
 * Deliberately per-search and in-memory, not persisted: this rations the fan-out WITHIN one
 * click. The monthly ceiling is still `callProviderWithBudget`'s job, underneath. The two
 * compose — this one decides whether a call is made at all, that one refuses to exceed the
 * month.
 *
 * A claim is taken even when the adapter goes on to serve the lookup from its own cache.
 * That is deliberate: the budget must bound the worst case, and an adapter's cache hit rate
 * is not knowable here. Erring toward fewer lookups costs a candidate its bed; erring the
 * other way costs the owner his month.
 */

import { maxStayLookupsPerSearch } from './caps';
import type { ProviderId } from './types';

export interface StayLookupBudget {
	/**
	 * Takes one lookup from `providerId`'s ration for this search, returning whether there
	 * was one to take. `costPerLookup` is that provider's own
	 * `estimateSearchStaysCost` — read on first claim to size the ration via
	 * `maxStayLookupsPerSearch`, and ignored afterwards, so a provider whose estimate
	 * varies by query cannot enlarge its own allowance mid-search.
	 */
	claim(providerId: ProviderId, costPerLookup: number): boolean;
	/** Lookups already claimed for `providerId` in this search. For tests and for the
	 * provenance/report surfaces that want to say what a search actually spent. */
	claimed(providerId: ProviderId): number;
}

export function createStayLookupBudget(): StayLookupBudget {
	const allowance = new Map<ProviderId, number>();
	const spent = new Map<ProviderId, number>();

	return {
		claim(providerId, costPerLookup) {
			let limit = allowance.get(providerId);
			if (limit === undefined) {
				limit = maxStayLookupsPerSearch(providerId, costPerLookup);
				allowance.set(providerId, limit);
			}
			const used = spent.get(providerId) ?? 0;
			if (used >= limit) return false;
			spent.set(providerId, used + 1);
			return true;
		},
		claimed(providerId) {
			return spent.get(providerId) ?? 0;
		}
	};
}

/**
 * A budget that never refuses. For the callers that legitimately have no fan-out to ration
 * — a single-candidate confirm, or a test exercising an adapter directly — so they express
 * "one lookup, deliberately" rather than passing `undefined` and re-opening the hole this
 * module exists to close.
 */
export function createUnboundedStayLookupBudget(): StayLookupBudget {
	const spent = new Map<ProviderId, number>();
	return {
		claim(providerId) {
			spent.set(providerId, (spent.get(providerId) ?? 0) + 1);
			return true;
		},
		claimed(providerId) {
			return spent.get(providerId) ?? 0;
		}
	};
}
