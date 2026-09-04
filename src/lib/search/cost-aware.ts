/**
 * Adapts registered `FlightProvider`/`StayProvider` adapters into `providers/budget`'s
 * `CostAwareSource` shape, so the staged free-then-metered decision this pipeline exists to
 * make is delegated to that module's `runCostAwareSearch`/`estimateWidenCost` (issue #22,
 * merged) rather than reimplemented here.
 *
 * `src/lib/providers/budget/` merged partway through this issue's work — this file, and
 * `pipeline.ts`'s use of it, replaced an earlier hand-rolled free/metered classifier
 * (`estimateSearchOffersCost(query) === 0`) once it did, per AGENTS.md: "if your issue
 * depends on something that does not exist yet ... wait or ... say so." It existed, so this
 * pipeline uses it.
 */

import { contextFor, isProviderUsable } from '../providers/registry';
import type {
	AvailableKeys,
	FlightProvider,
	FlightSearchQuery,
	ProviderId,
	StayProvider,
	StaySearchQuery
} from '../providers/types';
import { estimateWidenCost } from '../providers/budget';
import type { CostAwareSearchResult, CostAwareSource, ProviderTier, StayLookupBudget } from '../providers/budget';
import type { FlightOffer, Stay } from '../domain';
import type { RecordProviderCall, SourceTracker } from './provenance';

function tierFor(cost: number): ProviderTier {
	return cost === 0 ? 'free' : 'metered';
}

/**
 * One `CostAwareSource<FlightOffer[]>` per usable flight provider for one leg's query. Only
 * usable providers are included at all (`isProviderUsable`) — an adapter with no key
 * configured cannot run whether or not the caller later asks to widen to it; that case is
 * `WidenOption.requiresKey`'s job to surface, not `runCostAwareSearch`'s.
 */
export function flightCostAwareSources(
	providers: readonly FlightProvider[],
	query: FlightSearchQuery,
	keys: AvailableKeys,
	signal: AbortSignal,
	sources: SourceTracker,
	record: RecordProviderCall
): CostAwareSource<FlightOffer[]>[] {
	return providers
		.filter((provider) => isProviderUsable(provider, keys))
		.map((provider) => ({
			providerId: provider.id,
			tier: tierFor(provider.estimateSearchOffersCost(query)),
			estimatedCost: provider.estimateSearchOffersCost(query),
			run: async () => {
				const result = await provider.searchOffers(query, contextFor(provider.id, keys, signal));
				record(provider, result);
				if (result.ok) for (const offer of result.data) sources.attach(offer, result.source);
				return result;
			}
		}));
}

/** Same reasoning as `flightCostAwareSources`, for stay providers. Unlike flights, a
 * metered stay source here can still run without an explicit `widenTo` from the caller —
 * see `autoWidenStaySources` below, issue #94. */
export function stayCostAwareSources(
	providers: readonly StayProvider[],
	query: StaySearchQuery,
	keys: AvailableKeys,
	signal: AbortSignal,
	sources: SourceTracker,
	record: RecordProviderCall
): CostAwareSource<Stay[]>[] {
	return providers
		.filter((provider) => isProviderUsable(provider, keys))
		.map((provider) => ({
			providerId: provider.id,
			tier: tierFor(provider.estimateSearchStaysCost(query)),
			estimatedCost: provider.estimateSearchStaysCost(query),
			run: async () => {
				const result = await provider.searchStays(query, contextFor(provider.id, keys, signal));
				record(provider, result);
				if (result.ok) for (const stay of result.data) sources.attach(stay, result.source);
				return result;
			}
		}));
}

/**
 * Metered stay sources this search may still spend a lookup on — issue #94 for why they
 * auto-run at all, issue #148 for why the decision is now rationed rather than unanimous.
 * Pass the result straight into `runCostAwareSearch`'s `widenTo`: it never touches a free
 * source (nothing to widen to), and a metered source left out still shows up in
 * `report.skipped` and needs the explicit widen flow flight providers already go through,
 * rather than rotting into "always auto-runs" the day it's added.
 *
 * **This function has a side effect and must be called exactly once per stay lookup.** Each
 * returned provider has had one lookup deducted from `budget`. Calling it twice for one
 * lookup double-charges the search and silently halves how many candidates get a bed; not
 * calling it at all is the unbounded fan-out issue #148 was filed over. The name says
 * `claim` for that reason.
 *
 * The quota question is asked entirely through `budget`, whose per-provider ration is
 * `maxStayLookupsPerSearch` and which therefore already folds in `isQuotaGenerous`: a
 * provider too tight to auto-run at all gets a ration of zero and never claims. One gate,
 * not two that could drift apart.
 */
export function claimAutoWidenStaySources(
	sources: readonly CostAwareSource<unknown>[],
	budget: StayLookupBudget
): ProviderId[] {
	const claimed: ProviderId[] = [];
	for (const source of sources) {
		if (source.tier !== 'metered') continue;
		if (!budget.claim(source.providerId, source.estimatedCost)) continue;
		claimed.push(source.providerId);
	}
	return claimed;
}

/** Requests actually spent by the metered tier alone, read off a `runCostAwareSearch`
 * report's own result entries — `report.totalRequestsUsed` mixes in whatever the free tier
 * spent too, which must never count against a traveller's confirmed metered budget. */
export function meteredRequestsUsed(result: CostAwareSearchResult<unknown>): number {
	return result.results
		.filter((entry) => entry.tier === 'metered')
		.reduce((sum, entry) => sum + entry.outcome.requestsUsed, 0);
}

/**
 * Chooses which metered sources fit a finite remaining budget, cheapest first, so a
 * traveller's confirmed spend buys as many confirmations as it can rather than being
 * exhausted by whichever provider happened to be listed first. Each candidate's cost is
 * read via `providers/budget`'s own `estimateWidenCost` (a single-provider `widenTo` against
 * the full source list) rather than its `estimatedCost` field directly, so this stays the
 * one place that number is computed. Pure and estimate-based: the caller still measures real
 * spend afterwards (`meteredRequestsUsed`) and decrements its own running total from that,
 * since a provider's actual `requestsUsed` can differ from its estimate (a provider that
 * errors after one of several planned requests, say).
 */
export function pickMeteredWithinBudget(costAwareSources: readonly CostAwareSource<unknown>[], remaining: number): ProviderId[] {
	const metered = [...costAwareSources]
		.filter((source) => source.tier === 'metered')
		.sort((a, b) => a.estimatedCost - b.estimatedCost);

	const chosen: ProviderId[] = [];
	let committed = 0;
	for (const source of metered) {
		const cost = estimateWidenCost([...costAwareSources], [source.providerId]);
		if (committed + cost > remaining) break; // sorted ascending: nothing pricier fits either
		chosen.push(source.providerId);
		committed += cost;
	}
	return chosen;
}

/** Every `FlightOffer`/`Stay` from every source that actually ran and succeeded, in one flat
 * list — a failed or skipped source contributes nothing, same reasoning
 * `algorithm/crosscheck.ts`'s `collectSourcedOffers` gives: "a 403 or a timeout is not a $0
 * quote." */
export function flattenOk<T>(result: CostAwareSearchResult<T[]>): T[] {
	return result.results.flatMap((entry) => (entry.outcome.ok ? entry.outcome.data : []));
}
