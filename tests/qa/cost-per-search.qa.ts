/**
 * Invariant: one search costs a stated, bounded number of requests per provider.
 *
 * "Eighty-five percent of his Booking.com allowance went in a single morning" (AGENTS.md).
 * The counter said zero because it was a per-browser tally, and nothing anywhere had ever
 * written down what one click was allowed to cost. This measures it instead of estimating
 * it: the bench counts every request that leaves the app during one search and compares it
 * to `tests/qa/budget.ts`.
 *
 * The check is on the class, not on the number. It fails for any provider over budget, for
 * any host nobody declared, and for a budget table that has itself drifted past what the
 * free tier can pay for — so a future provider added with a hidden fan-out fails here
 * without anybody thinking to write a test for it.
 */

import { test, expect } from './support/bench';
import { REQUESTS_PER_SEARCH, budgetsThatOutrunTheirFreeTier, describeVerdict, judge } from './budget';
import { resultsUrl } from './support/scenario';
import { waitForSearchToSettle } from './support/page';

test.describe('cost per search', () => {
	test('the declared budget still leaves a month of searches', () => {
		// An empty budget table declares nothing that outruns anything. Issue #382.
		expect(
			Object.keys(REQUESTS_PER_SEARCH).length,
			'tests/qa/budget.ts declares no provider'
		).toBeGreaterThan(0);

		const problems = budgetsThatOutrunTheirFreeTier();
		expect(
			problems,
			`tests/qa/budget.ts declares a per-search cost the free tier cannot pay for:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\nLowering the app's cost is the fix. Raising the budget is not.`
		).toEqual([]);
	});

	test('one search stays inside every provider budget', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);

		// The premise, before the budget. "Nothing went over budget" is also what a search that
		// made no requests at all produces, and this is the check standing between the owner's
		// free tier and an agent's afternoon. Issue #382.
		const counts = bench.countsByProvider();
		expect(
			counts.size,
			`this search called no provider at all:\n${bench.describeTraffic()}`
		).toBeGreaterThan(0);

		const over: string[] = [];
		for (const [providerId, count] of counts) {
			if (providerId === undefined) continue;
			const budget = REQUESTS_PER_SEARCH[providerId];
			if (budget === undefined || count <= budget) continue;
			over.push(describeVerdict(judge(providerId, count)));
		}

		expect(
			over,
			[
				'One search went over budget:',
				...over.map((line) => `  - ${line}`),
				'',
				'Every provider this search touched:',
				bench.describeTraffic(),
				'',
				'The budget is tests/qa/budget.ts. Raising a number there is a deliberate act;',
				'the failure above says what it costs in searches per month.'
			].join('\n')
		).toEqual([]);
	});

	test('every provider the search touches has a declared budget', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);

		const called = [...bench.countsByProvider().keys()];
		expect(
			called.length,
			`this search called no provider at all:\n${bench.describeTraffic()}`
		).toBeGreaterThan(0);

		const undeclared = called.filter(
			(providerId) => providerId !== undefined && REQUESTS_PER_SEARCH[providerId] === undefined
		);

		expect(
			undeclared,
			`These providers were called but have no entry in tests/qa/budget.ts: ${undeclared.join(', ')}. A provider with no declared cost is a cost nobody has looked at.`
		).toEqual([]);
	});
});
