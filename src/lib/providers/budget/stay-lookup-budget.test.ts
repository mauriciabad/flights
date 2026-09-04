/**
 * Issue #148. The numbers asserted here are the ones the PR quotes as "what one click
 * costs", so they are deliberately spelled out rather than derived in the test: if a cap
 * changes and these fail, the claim in the PR body has changed too and both should be
 * revisited together.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearProviderCapOverride, setProviderCapOverride } from './caps';
import { maxStayLookupsPerSearch } from './caps';
import { createStayLookupBudget, createUnboundedStayLookupBudget } from './stay-lookup-budget';

/** Real adapter costs, from `stays/agoda.ts` and `stays/booking.ts`'s own
 * `estimateSearchStaysCost` (1 search + N drill-downs). */
const AGODA_COST_PER_LOOKUP = 6;
const BOOKING_COST_PER_LOOKUP = 2;

beforeEach(() => {
	clearProviderCapOverride('agoda');
	clearProviderCapOverride('booking');
	clearProviderCapOverride('skyscanner');
});

describe('maxStayLookupsPerSearch (issue #148)', () => {
	it('rations Booking to one lookup and Agoda to three per search', () => {
		// The whole bug in one assertion. Before this existed the pipeline took a lookup per
		// connection candidate — 6 ordinarily, 24 on the fallback sweep — so Booking's real
		// worst case was 48 requests from one click against a 50-a-month tier.
		expect(maxStayLookupsPerSearch('booking', BOOKING_COST_PER_LOOKUP)).toBe(1);
		expect(maxStayLookupsPerSearch('agoda', AGODA_COST_PER_LOOKUP)).toBe(3);
	});

	it('bounds one search to 2 Booking and 18 Agoda requests, worst case', () => {
		// The number the PR quotes. Requests, not lookups — this is what lands on the key.
		expect(maxStayLookupsPerSearch('booking', BOOKING_COST_PER_LOOKUP) * BOOKING_COST_PER_LOOKUP).toBe(2);
		expect(maxStayLookupsPerSearch('agoda', AGODA_COST_PER_LOOKUP) * AGODA_COST_PER_LOOKUP).toBe(18);
	});

	it('leaves both keys good for at least 20 searches a month, which is what the threshold promises', () => {
		expect(40 / (maxStayLookupsPerSearch('booking', BOOKING_COST_PER_LOOKUP) * BOOKING_COST_PER_LOOKUP)).toBeGreaterThanOrEqual(20);
		expect(400 / (maxStayLookupsPerSearch('agoda', AGODA_COST_PER_LOOKUP) * AGODA_COST_PER_LOOKUP)).toBeGreaterThanOrEqual(20);
	});

	it('gives a Sky-Scrapper-tight provider no lookups at all, so it still needs explicit consent', () => {
		// cap 15, one request per lookup: 15/20 < 1, so not even one unasked lookup.
		expect(maxStayLookupsPerSearch('skyscanner', 1)).toBe(0);
	});

	it('respects a user cap override, since a person who read their own dashboard knows better', () => {
		setProviderCapOverride('booking', 200);
		expect(maxStayLookupsPerSearch('booking', BOOKING_COST_PER_LOOKUP)).toBe(5);
	});

	it('rations nothing for a free provider', () => {
		expect(maxStayLookupsPerSearch('ryanair', 0)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('createStayLookupBudget (issue #148)', () => {
	it('grants Booking exactly one lookup however many candidates ask', () => {
		const budget = createStayLookupBudget();
		// Twenty-four candidates, the fallback sweep's worst case.
		const granted = Array.from({ length: 24 }, () => budget.claim('booking', BOOKING_COST_PER_LOOKUP));
		expect(granted.filter(Boolean)).toHaveLength(1);
		expect(budget.claimed('booking')).toBe(1);
	});

	it('grants Agoda exactly three lookups however many candidates ask', () => {
		const budget = createStayLookupBudget();
		const granted = Array.from({ length: 24 }, () => budget.claim('agoda', AGODA_COST_PER_LOOKUP));
		expect(granted.filter(Boolean)).toHaveLength(3);
	});

	it('rations each provider separately, so Booking running dry does not starve Agoda', () => {
		const budget = createStayLookupBudget();
		for (let i = 0; i < 10; i += 1) {
			budget.claim('booking', BOOKING_COST_PER_LOOKUP);
			budget.claim('agoda', AGODA_COST_PER_LOOKUP);
		}
		expect(budget.claimed('booking')).toBe(1);
		expect(budget.claimed('agoda')).toBe(3);
	});

	it('refuses a provider too tight to auto-run even once', () => {
		const budget = createStayLookupBudget();
		expect(budget.claim('skyscanner', 1)).toBe(false);
	});

	it('sizes the ration on first claim and ignores a later, larger cost estimate', () => {
		// A provider cannot enlarge its own allowance mid-search by reporting a different
		// estimate on a later candidate.
		const budget = createStayLookupBudget();
		expect(budget.claim('agoda', AGODA_COST_PER_LOOKUP)).toBe(true);
		budget.claim('agoda', 1);
		budget.claim('agoda', 1);
		budget.claim('agoda', 1);
		expect(budget.claimed('agoda')).toBe(3);
	});

	it('is per-search: a second search gets a fresh ration', () => {
		const first = createStayLookupBudget();
		first.claim('booking', BOOKING_COST_PER_LOOKUP);
		expect(first.claim('booking', BOOKING_COST_PER_LOOKUP)).toBe(false);

		const second = createStayLookupBudget();
		expect(second.claim('booking', BOOKING_COST_PER_LOOKUP)).toBe(true);
	});
});

describe('createUnboundedStayLookupBudget', () => {
	it('never refuses, and still counts', () => {
		const budget = createUnboundedStayLookupBudget();
		for (let i = 0; i < 50; i += 1) expect(budget.claim('booking', BOOKING_COST_PER_LOOKUP)).toBe(true);
		expect(budget.claimed('booking')).toBe(50);
	});
});
