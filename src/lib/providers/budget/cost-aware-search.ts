import type { ProviderCallOutcome, ProviderId } from './types';

export type ProviderTier = 'free' | 'metered';

export interface CostAwareSource<T> {
	providerId: ProviderId;
	/** `free` sources always run. `metered` sources run only when named in `widenTo`. */
	tier: ProviderTier;
	/** Requests this source spends if it runs, so a caller can show the cost before the user opts in. */
	estimatedCost: number;
	/** Should route through `callProviderWithBudget` so quota, dedup and retry are already handled — this module only decides *whether* to call it. */
	run: () => Promise<ProviderCallOutcome<T>>;
}

export interface CostAwareResultEntry<T> {
	providerId: ProviderId;
	tier: ProviderTier;
	outcome: ProviderCallOutcome<T>;
}

export interface CostAwareSkip {
	providerId: ProviderId;
	reason: 'not-requested';
}

export interface CostAwareSearchReport {
	ranFree: ProviderId[];
	ranMetered: ProviderId[];
	skipped: CostAwareSkip[];
	/** Real provider requests this search spent, across every source that ran. What issue #17 and a "this search cost N requests" UI both read. */
	totalRequestsUsed: number;
}

export interface CostAwareSearchResult<T> {
	results: CostAwareResultEntry<T>[];
	report: CostAwareSearchReport;
}

export interface CostAwareSearchOptions {
	/**
	 * Metered providers to actually spend budget on this run — normally
	 * chosen after showing the user `estimateWidenCost` for the same list and
	 * getting them to agree to it. Free sources run regardless of this list.
	 */
	widenTo?: ProviderId[];
}

/**
 * Runs every free source unconditionally and every metered source named in
 * `widenTo`, leaving the rest untouched. This is the mechanism behind
 * "cheap sources answer first, the user explicitly asks to widen": a metered
 * source left out of `widenTo` never runs, so it never spends a request —
 * it only shows up in `report.skipped`. Deciding *which* metered sources are
 * worth widening to (ranking connection candidates, etc.) is a search
 * pipeline concern, not this module's — it only enforces the opt-in gate.
 */
export async function runCostAwareSearch<T>(
	sources: CostAwareSource<T>[],
	options: CostAwareSearchOptions = {}
): Promise<CostAwareSearchResult<T>> {
	const widenTo = new Set(options.widenTo ?? []);
	const toRun = sources.filter((source) => source.tier === 'free' || widenTo.has(source.providerId));
	const skipped: CostAwareSkip[] = sources
		.filter((source) => source.tier === 'metered' && !widenTo.has(source.providerId))
		.map((source) => ({ providerId: source.providerId, reason: 'not-requested' as const }));

	const results = await Promise.all(
		toRun.map(
			async (source): Promise<CostAwareResultEntry<T>> => ({
				providerId: source.providerId,
				tier: source.tier,
				outcome: await source.run()
			})
		)
	);

	const report: CostAwareSearchReport = {
		ranFree: results.filter((entry) => entry.tier === 'free').map((entry) => entry.providerId),
		ranMetered: results.filter((entry) => entry.tier === 'metered').map((entry) => entry.providerId),
		skipped,
		totalRequestsUsed: results.reduce((sum, entry) => sum + entry.outcome.requestsUsed, 0)
	};

	return { results, report };
}

/** What spending on every named metered source would cost — call this to show the price of widening before the user agrees to pass the same list as `widenTo`. */
export function estimateWidenCost<T>(sources: CostAwareSource<T>[], widenTo: ProviderId[]): number {
	const wanted = new Set(widenTo);
	return sources
		.filter((source) => source.tier === 'metered' && wanted.has(source.providerId))
		.reduce((sum, source) => sum + source.estimatedCost, 0);
}
