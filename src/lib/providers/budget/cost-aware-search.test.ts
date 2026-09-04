import { describe, expect, it, vi } from 'vitest';
import { estimateWidenCost, runCostAwareSearch } from './cost-aware-search';
import type { CostAwareSource } from './cost-aware-search';
import type { ProviderCallOutcome } from './types';

function success<T>(providerId: string, value: T, requestsUsed = 1): ProviderCallOutcome<T> {
	return { ok: true, providerId, value, requestsUsed, attempts: 1 };
}

describe('runCostAwareSearch', () => {
	it('always runs free sources', async () => {
		const ryanair = vi.fn(async () => success('ryanair', ['fare']));
		const sources: CostAwareSource<string[]>[] = [
			{ providerId: 'ryanair', tier: 'free', estimatedCost: 0, run: ryanair }
		];

		const { report } = await runCostAwareSearch(sources);

		expect(ryanair).toHaveBeenCalledTimes(1);
		expect(report.ranFree).toEqual(['ryanair']);
	});

	it('does not run a metered source that was not asked for', async () => {
		const skyScrapper = vi.fn(async () => success('sky-scrapper', ['fare']));
		const sources: CostAwareSource<string[]>[] = [
			{ providerId: 'sky-scrapper', tier: 'metered', estimatedCost: 2, run: skyScrapper }
		];

		const { report } = await runCostAwareSearch(sources);

		expect(skyScrapper).not.toHaveBeenCalled();
		expect(report.ranMetered).toEqual([]);
		expect(report.skipped).toEqual([{ providerId: 'sky-scrapper', reason: 'not-requested' }]);
	});

	it('runs a metered source once the caller explicitly widens to it', async () => {
		const skyScrapper = vi.fn(async () => success('sky-scrapper', ['fare']));
		const sources: CostAwareSource<string[]>[] = [
			{ providerId: 'sky-scrapper', tier: 'metered', estimatedCost: 2, run: skyScrapper }
		];

		const { report } = await runCostAwareSearch(sources, { widenTo: ['sky-scrapper'] });

		expect(skyScrapper).toHaveBeenCalledTimes(1);
		expect(report.ranMetered).toEqual(['sky-scrapper']);
		expect(report.skipped).toEqual([]);
	});

	it('reports the total requests actually used across every source that ran', async () => {
		const sources: CostAwareSource<string[]>[] = [
			{ providerId: 'ryanair', tier: 'free', estimatedCost: 0, run: async () => success('ryanair', [], 0) },
			{
				providerId: 'sky-scrapper',
				tier: 'metered',
				estimatedCost: 2,
				run: async () => success('sky-scrapper', [], 2)
			},
			{
				providerId: 'flights-sky',
				tier: 'metered',
				estimatedCost: 1,
				run: async () => success('flights-sky', [], 1)
			}
		];

		const { report } = await runCostAwareSearch(sources, { widenTo: ['sky-scrapper'] });

		// flights-sky was never requested, so its cost never gets counted even though it exists.
		expect(report.totalRequestsUsed).toBe(2);
		expect(report.skipped).toEqual([{ providerId: 'flights-sky', reason: 'not-requested' }]);
	});

	it('surfaces a failed source in results rather than throwing', async () => {
		const sources: CostAwareSource<string[]>[] = [
			{
				providerId: 'sky-scrapper',
				tier: 'metered',
				estimatedCost: 1,
				run: async () => ({
					ok: false,
					providerId: 'sky-scrapper',
					requestsUsed: 1,
					attempts: 1,
					error: { kind: 'unknown', providerId: 'sky-scrapper', message: 'boom' }
				})
			}
		];

		const { results } = await runCostAwareSearch(sources, { widenTo: ['sky-scrapper'] });

		expect(results).toHaveLength(1);
		expect(results[0]?.outcome.ok).toBe(false);
	});
});

describe('estimateWidenCost', () => {
	it('sums the estimated cost of only the named metered sources', () => {
		const sources: CostAwareSource<unknown>[] = [
			{ providerId: 'ryanair', tier: 'free', estimatedCost: 0, run: async () => success('ryanair', null) },
			{ providerId: 'sky-scrapper', tier: 'metered', estimatedCost: 2, run: async () => success('sky-scrapper', null) },
			{ providerId: 'flights-sky', tier: 'metered', estimatedCost: 1, run: async () => success('flights-sky', null) }
		];

		expect(estimateWidenCost(sources, ['sky-scrapper', 'flights-sky'])).toBe(3);
		expect(estimateWidenCost(sources, ['sky-scrapper'])).toBe(2);
		expect(estimateWidenCost(sources, [])).toBe(0);
	});

	it('ignores a free source even if its id is passed in widenTo', () => {
		const sources: CostAwareSource<unknown>[] = [
			{ providerId: 'ryanair', tier: 'free', estimatedCost: 0, run: async () => success('ryanair', null) }
		];

		expect(estimateWidenCost(sources, ['ryanair'])).toBe(0);
	});
});
