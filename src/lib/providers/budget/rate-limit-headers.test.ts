import { describe, expect, it } from 'vitest';
import { parseRateLimitWindows, pickQuotaWindow } from './rate-limit-headers';

/** RapidAPI's documented plan-quota triple. Written out here rather than imported from a
 * fixture because no response captured in this repo has ever carried these headers — see
 * `rate-limit-headers.ts`'s header. These are the documented spellings, and the parser is
 * tested below against unexpected ones too, precisely because they are unverified. */
function quotaHeaders(limit: string, remaining: string, resetSeconds: string): Headers {
	return new Headers({
		'x-ratelimit-requests-limit': limit,
		'x-ratelimit-requests-remaining': remaining,
		'x-ratelimit-requests-reset': resetSeconds,
		'content-type': 'application/json'
	});
}

describe('parseRateLimitWindows', () => {
	it('reads RapidAPI’s documented plan-quota triple', () => {
		expect(parseRateLimitWindows(quotaHeaders('50', '7', '1209600'))).toEqual([
			{
				scope: 'requests',
				limit: 50,
				remaining: 7,
				resetSeconds: 1209600,
				headerNames: [
					'x-ratelimit-requests-limit',
					'x-ratelimit-requests-remaining',
					'x-ratelimit-requests-reset'
				]
			}
		]);
	});

	it('finds nothing in a response that carried no rate-limit headers', () => {
		// The expected case in a browser until someone measures a real RapidAPI response:
		// a cross-origin fetch cannot read a header the server does not expose.
		expect(parseRateLimitWindows(new Headers({ 'content-type': 'application/json' }))).toEqual([]);
	});

	it('keeps the plan quota and the burst window apart', () => {
		const headers = new Headers({
			'x-ratelimit-requests-limit': '50',
			'x-ratelimit-requests-remaining': '7',
			'x-ratelimit-limit': '1000',
			'x-ratelimit-remaining': '998'
		});
		const windows = parseRateLimitWindows(headers);
		expect(windows.map((window) => window.scope).sort()).toEqual(['', 'requests']);
		expect(windows.find((window) => window.scope === '')?.remaining).toBe(998);
	});

	it('drops a window that reports a limit but never says how much is left', () => {
		expect(parseRateLimitWindows(new Headers({ 'x-ratelimit-requests-limit': '50' }))).toEqual([]);
	});

	it.each([['not-a-number'], ['-4'], ['3.5'], ['']])('ignores a non-count value %j', (value) => {
		const headers = new Headers({
			'x-ratelimit-requests-limit': '50',
			'x-ratelimit-requests-remaining': value
		});
		expect(parseRateLimitWindows(headers)).toEqual([]);
	});

	it('matches header names case-insensitively, as HTTP requires', () => {
		const headers = new Headers({ 'X-RateLimit-Requests-Remaining': '9' });
		expect(parseRateLimitWindows(headers)[0]?.remaining).toBe(9);
	});
});

describe('pickQuotaWindow', () => {
	it('prefers the window RapidAPI documents as the plan quota', () => {
		const headers = new Headers({
			'x-ratelimit-requests-limit': '50',
			'x-ratelimit-requests-remaining': '7',
			'x-ratelimit-limit': '1000',
			'x-ratelimit-remaining': '998'
		});
		expect(pickQuotaWindow(parseRateLimitWindows(headers))?.remaining).toBe(7);
	});

	it('recognises a quota under a name nobody documented, from its own reset window', () => {
		// The whole point of not hardcoding the name: if RapidAPI ever spells it
		// differently, a month-long reset still identifies it as a plan quota.
		const headers = new Headers({
			'x-ratelimit-quota-limit': '500',
			'x-ratelimit-quota-remaining': '120',
			'x-ratelimit-quota-reset': '1209600'
		});
		expect(pickQuotaWindow(parseRateLimitWindows(headers))?.scope).toBe('quota');
	});

	it('refuses to read a burst window as the month’s allowance', () => {
		// Reading "998 of 1000 left this minute" as the plan quota would record 2 requests
		// spent this month, or worse, refuse every search for the rest of the month once
		// the minute window ran low. Learning nothing is the correct outcome here.
		const headers = new Headers({
			'x-ratelimit-limit': '1000',
			'x-ratelimit-remaining': '5',
			'x-ratelimit-reset': '42'
		});
		expect(pickQuotaWindow(parseRateLimitWindows(headers))).toBeUndefined();
	});

	it('takes the longest window when several could be quotas', () => {
		const headers = new Headers({
			'x-ratelimit-daily-remaining': '9',
			'x-ratelimit-daily-reset': '86400',
			'x-ratelimit-monthly-remaining': '300',
			'x-ratelimit-monthly-reset': '1209600'
		});
		expect(pickQuotaWindow(parseRateLimitWindows(headers))?.scope).toBe('monthly');
	});

	it('finds no quota in an empty list', () => {
		expect(pickQuotaWindow([])).toBeUndefined();
	});
});
