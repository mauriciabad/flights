import { beforeEach, describe, expect, it } from 'vitest';
import {
	getReportedProviderQuota,
	loadReportedQuotaState,
	recordRateLimitHeaders,
	saveReportedQuotaState
} from './reported-quota';

const SEP_2026 = Date.UTC(2026, 8, 4); // 2026-09, "today" per docs/PROVIDERS.md
const OCT_2026 = Date.UTC(2026, 9, 2);

const DAY_MS = 86_400_000;

function quotaHeaders(limit: number, remaining: number, resetSeconds?: number): Headers {
	const headers = new Headers({
		'x-ratelimit-requests-limit': String(limit),
		'x-ratelimit-requests-remaining': String(remaining)
	});
	if (resetSeconds !== undefined) headers.set('x-ratelimit-requests-reset', String(resetSeconds));
	return headers;
}

beforeEach(() => {
	localStorage.clear();
});

describe('recordRateLimitHeaders', () => {
	it('stores what the provider said, with the instant it said it', () => {
		const reading = recordRateLimitHeaders('booking', quotaHeaders(50, 7, 86400), { now: () => SEP_2026 });
		expect(reading).toEqual({
			monthKey: '2026-09',
			limit: 50,
			remaining: 7,
			observedAt: SEP_2026,
			resetsAt: SEP_2026 + DAY_MS,
			scope: 'requests',
			headerNames: [
				'x-ratelimit-requests-limit',
				'x-ratelimit-requests-remaining',
				'x-ratelimit-requests-reset'
			]
		});
		expect(getReportedProviderQuota('booking', { now: () => SEP_2026 })).toEqual(reading);
	});

	it('learns nothing, and forgets nothing, from a response with no quota headers', () => {
		recordRateLimitHeaders('booking', quotaHeaders(50, 7, 86400), { now: () => SEP_2026 });
		const second = recordRateLimitHeaders('booking', new Headers({ 'content-type': 'application/json' }), {
			now: () => SEP_2026 + 1000
		});

		expect(second).toBeUndefined();
		expect(getReportedProviderQuota('booking', { now: () => SEP_2026 + 1000 })?.remaining).toBe(7);
	});

	it('takes the newest answer even when it reports more left than the last one', () => {
		// A plan can be upgraded and a daily window can roll over. Clamping to the smaller
		// number would be this app preferring its own arithmetic to the provider's
		// statement, which is the exact habit issue #146 is about.
		recordRateLimitHeaders('agoda', quotaHeaders(500, 12), { now: () => SEP_2026 });
		recordRateLimitHeaders('agoda', quotaHeaders(500, 480), { now: () => SEP_2026 + 60_000 });
		expect(getReportedProviderQuota('agoda', { now: () => SEP_2026 + 60_000 })?.remaining).toBe(480);
	});

	it('keeps one provider’s reading out of another’s', () => {
		recordRateLimitHeaders('booking', quotaHeaders(50, 7), { now: () => SEP_2026 });
		expect(getReportedProviderQuota('agoda', { now: () => SEP_2026 })).toBeUndefined();
	});
});

describe('getReportedProviderQuota', () => {
	it('discards a reading taken in an earlier month', () => {
		recordRateLimitHeaders('booking', quotaHeaders(50, 0), { now: () => SEP_2026 });
		expect(getReportedProviderQuota('booking', { now: () => OCT_2026 })).toBeUndefined();
	});

	it('discards a reading whose own window has since reset', () => {
		recordRateLimitHeaders('booking', quotaHeaders(50, 0, 3600), { now: () => SEP_2026 });
		expect(getReportedProviderQuota('booking', { now: () => SEP_2026 + 3_600_001 })).toBeUndefined();
	});

	it('keeps a reading whose window has not reset yet', () => {
		recordRateLimitHeaders('booking', quotaHeaders(50, 3, 3600), { now: () => SEP_2026 });
		expect(getReportedProviderQuota('booking', { now: () => SEP_2026 + 3_599_000 })?.remaining).toBe(3);
	});

	it('reads a corrupt store as “no provider has told us anything”', () => {
		localStorage.setItem('flights.providerBudget.reported.v1', '{not json');
		expect(loadReportedQuotaState()).toEqual({});
		expect(getReportedProviderQuota('booking', { now: () => SEP_2026 })).toBeUndefined();
	});

	it('drops a stored entry that does not have the shape this module writes', () => {
		saveReportedQuotaState({
			booking: { monthKey: '2026-09', remaining: 7, observedAt: SEP_2026, scope: 'requests', headerNames: [] }
		});
		localStorage.setItem(
			'flights.providerBudget.reported.v1',
			JSON.stringify({ booking: { monthKey: '2026-09', remaining: 'lots' } })
		);
		expect(getReportedProviderQuota('booking', { now: () => SEP_2026 })).toBeUndefined();
	});
});
