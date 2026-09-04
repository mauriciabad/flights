import { beforeEach, describe, expect, it } from 'vitest';
import { getProviderQuotaSnapshot, reserveProviderRequests } from './quota';
import { saveProviderQuotaState } from './quota-storage';
import { recordRateLimitHeaders } from './reported-quota';

const AUG_2026 = Date.UTC(2026, 7, 15); // 2026-08
const SEP_2026 = Date.UTC(2026, 8, 4); // 2026-09, "today" per docs/PROVIDERS.md

beforeEach(() => {
	localStorage.clear();
});

describe('reserveProviderRequests', () => {
	it('allows a reservation under the cap and persists the new usage', () => {
		const result = reserveProviderRequests('skyscanner', 1, { cap: 15, now: () => SEP_2026 });
		expect(result).toMatchObject({ ok: true, used: 1, cap: 15, monthKey: '2026-09' });
	});

	it('refuses a reservation that would exceed the cap, and leaves usage unchanged', () => {
		reserveProviderRequests('skyscanner', 15, { cap: 15, now: () => SEP_2026 }); // spend it all
		const refusal = reserveProviderRequests('skyscanner', 1, { cap: 15, now: () => SEP_2026 });
		expect(refusal).toMatchObject({ ok: false, used: 15, cap: 15, monthKey: '2026-09', refusal: 'local-cap' });
	});

	it('refuses a single reservation whose cost alone exceeds the cap', () => {
		const refusal = reserveProviderRequests('skyscanner', 20, { cap: 15, now: () => SEP_2026 });
		expect(refusal.ok).toBe(false);
		expect(refusal.used).toBe(0);
	});

	it('allows a reservation that lands exactly on the cap', () => {
		const result = reserveProviderRequests('skyscanner', 15, { cap: 15, now: () => SEP_2026 });
		expect(result).toMatchObject({ ok: true, used: 15, cap: 15, monthKey: '2026-09' });
	});

	it('keeps separate providers on separate counters', () => {
		reserveProviderRequests('skyscanner', 15, { cap: 15, now: () => SEP_2026 });
		const flightsSky = reserveProviderRequests('flights-sky', 1, { cap: 40, now: () => SEP_2026 });
		expect(flightsSky).toMatchObject({ ok: true, used: 1, cap: 40, monthKey: '2026-09' });
	});

	it('resets the counter at a month boundary instead of carrying usage forward', () => {
		// August closes out nearly at cap...
		saveProviderQuotaState({ 'skyscanner': { monthKey: '2026-08', used: 14 } });

		// ...but a reservation made in September reads as a fresh month, because
		// the provider's own quota reset the moment the calendar month did.
		const result = reserveProviderRequests('skyscanner', 1, { cap: 15, now: () => SEP_2026 });
		expect(result).toMatchObject({ ok: true, used: 1, cap: 15, monthKey: '2026-09' });
	});

	it('would have refused the same reservation had the month not turned over', () => {
		saveProviderQuotaState({ 'skyscanner': { monthKey: '2026-08', used: 14 } });
		const result = reserveProviderRequests('skyscanner', 2, { cap: 15, now: () => AUG_2026 });
		expect(result.ok).toBe(false);
	});

	it('uses the stored/default cap when none is passed explicitly', () => {
		// sky-scrapper's default cap is 15 (see caps.ts) — the 16th request should be refused.
		for (let i = 0; i < 15; i++) reserveProviderRequests('skyscanner', 1, { now: () => SEP_2026 });
		const refusal = reserveProviderRequests('skyscanner', 1, { now: () => SEP_2026 });
		expect(refusal.ok).toBe(false);
		expect(refusal.cap).toBe(15);
	});
});

describe('getProviderQuotaSnapshot', () => {
	it('reports zero usage for a provider that has never been called', () => {
		expect(getProviderQuotaSnapshot('skyscanner', { cap: 15, now: () => SEP_2026 })).toEqual({
			providerId: 'skyscanner',
			monthKey: '2026-09',
			used: 0,
			locallyCounted: 0,
			cap: 15,
			remaining: 15,
			reported: undefined
		});
	});

	it('reflects reservations already made this month', () => {
		reserveProviderRequests('skyscanner', 4, { cap: 15, now: () => SEP_2026 });
		expect(getProviderQuotaSnapshot('skyscanner', { cap: 15, now: () => SEP_2026 })).toEqual({
			providerId: 'skyscanner',
			monthKey: '2026-09',
			used: 4,
			locallyCounted: 4,
			cap: 15,
			remaining: 11,
			reported: undefined
		});
	});

	it('never mutates stored usage just by being read', () => {
		getProviderQuotaSnapshot('skyscanner', { cap: 15, now: () => SEP_2026 });
		getProviderQuotaSnapshot('skyscanner', { cap: 15, now: () => SEP_2026 });
		expect(getProviderQuotaSnapshot('skyscanner', { cap: 15, now: () => SEP_2026 }).used).toBe(0);
	});

	it('reports a stale prior-month record as zero usage', () => {
		saveProviderQuotaState({ 'skyscanner': { monthKey: '2026-08', used: 14 } });
		expect(getProviderQuotaSnapshot('skyscanner', { cap: 15, now: () => SEP_2026 }).used).toBe(0);
	});
});

/**
 * Issue #146, and the reason this file grew a third describe block. The owner's
 * Booking.com month was 85% gone while the settings card read "0 of 40 requests spent".
 * Both numbers were true: the tally lives in one browser, the allowance lives on the
 * RapidAPI key. Every case below is that same gap, and every one of them passes only
 * because `reserveProviderRequests` now believes the provider over its own counter.
 */
describe('reconciling the local tally with what the provider itself reported', () => {
	function reportRemaining(remaining: number, limit?: number, resetSeconds?: number): void {
		const headers = new Headers({ 'x-ratelimit-requests-remaining': String(remaining) });
		if (limit !== undefined) headers.set('x-ratelimit-requests-limit', String(limit));
		if (resetSeconds !== undefined) headers.set('x-ratelimit-requests-reset', String(resetSeconds));
		recordRateLimitHeaders('booking', headers, { now: () => SEP_2026 });
	}

	it('stops a browser that has counted nothing but is spending an already-emptied month', () => {
		// The exact shape of the failure: a fresh profile, a zero local tally, and a key
		// that Booking.com says has 8 of its 50 left. 42 spent is already past this app's
		// own 40-request safety cap, so the next request must not go out.
		reportRemaining(8, 50);
		const refusal = reserveProviderRequests('booking', 1, { cap: 40, now: () => SEP_2026 });
		expect(refusal.ok).toBe(false);
		expect(refusal.used).toBe(42);
		expect(refusal.refusal).toBe('local-cap');
	});

	it('names the provider, not this app’s cap, when the key itself is empty', () => {
		reportRemaining(0, 50);
		const refusal = reserveProviderRequests('booking', 1, { cap: 40, now: () => SEP_2026 });
		expect(refusal.refusal).toBe('provider-reported-empty');
		expect(refusal.reported?.remaining).toBe(0);
	});

	it('stops on a bare remaining count, with no limit to subtract it from', () => {
		// `limit - remaining` is unavailable here, so there is no usage figure at all —
		// but "2 left" is still a hard fact about a call that costs 3.
		reportRemaining(2);
		expect(reserveProviderRequests('booking', 3, { cap: 40, now: () => SEP_2026 }).ok).toBe(false);
		expect(reserveProviderRequests('booking', 2, { cap: 40, now: () => SEP_2026 }).ok).toBe(true);
	});

	it('shows the account’s position on the settings card, not this browser’s zero', () => {
		reportRemaining(8, 50);
		const snapshot = getProviderQuotaSnapshot('booking', { cap: 40, now: () => SEP_2026 });
		expect(snapshot.used).toBe(42);
		expect(snapshot.locallyCounted).toBe(0);
		expect(snapshot.remaining).toBe(0);
		expect(snapshot.reported?.observedAt).toBe(SEP_2026);
	});

	it('never lets the app plan to spend more than the provider says exists', () => {
		// 38 of this app's own 40-request cap are unspent, but the key has 3 left. The
		// smaller, provider-supplied number is the one a "what can I still do" screen has
		// to show.
		reportRemaining(3, 5);
		expect(getProviderQuotaSnapshot('booking', { cap: 40, now: () => SEP_2026 }).remaining).toBe(3);
	});

	it('keeps counting this browser’s own requests separately from the reported figure', () => {
		reportRemaining(30, 50);
		reserveProviderRequests('booking', 1, { cap: 40, now: () => SEP_2026 });
		const snapshot = getProviderQuotaSnapshot('booking', { cap: 40, now: () => SEP_2026 });
		expect(snapshot.locallyCounted).toBe(1);
		expect(snapshot.used).toBe(20);
	});

	it('falls back to the local tally when this browser has counted more than the report', () => {
		reportRemaining(49, 50);
		reserveProviderRequests('booking', 5, { cap: 40, now: () => SEP_2026 });
		expect(getProviderQuotaSnapshot('booking', { cap: 40, now: () => SEP_2026 }).used).toBe(5);
	});

	it('ignores a report from last month rather than carrying it forward', () => {
		reportRemaining(0, 50);
		const october = Date.UTC(2026, 9, 2);
		expect(reserveProviderRequests('booking', 1, { cap: 40, now: () => october }).ok).toBe(true);
	});

	it('ignores a report whose own window has already reset', () => {
		reportRemaining(0, 50, 3600);
		const laterSameMonth = SEP_2026 + 3_600_001;
		expect(reserveProviderRequests('booking', 1, { cap: 40, now: () => laterSameMonth }).ok).toBe(true);
	});
});
