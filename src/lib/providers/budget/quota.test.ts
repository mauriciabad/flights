import { beforeEach, describe, expect, it } from 'vitest';
import { getProviderQuotaSnapshot, reserveProviderRequests } from './quota';
import { saveProviderQuotaState } from './quota-storage';

const AUG_2026 = Date.UTC(2026, 7, 15); // 2026-08
const SEP_2026 = Date.UTC(2026, 8, 4); // 2026-09, "today" per docs/PROVIDERS.md

beforeEach(() => {
	localStorage.clear();
});

describe('reserveProviderRequests', () => {
	it('allows a reservation under the cap and persists the new usage', () => {
		const result = reserveProviderRequests('sky-scrapper', 1, { cap: 15, now: () => SEP_2026 });
		expect(result).toEqual({ ok: true, used: 1, cap: 15, monthKey: '2026-09' });
	});

	it('refuses a reservation that would exceed the cap, and leaves usage unchanged', () => {
		reserveProviderRequests('sky-scrapper', 15, { cap: 15, now: () => SEP_2026 }); // spend it all
		const refusal = reserveProviderRequests('sky-scrapper', 1, { cap: 15, now: () => SEP_2026 });
		expect(refusal).toEqual({ ok: false, used: 15, cap: 15, monthKey: '2026-09' });
	});

	it('refuses a single reservation whose cost alone exceeds the cap', () => {
		const refusal = reserveProviderRequests('sky-scrapper', 20, { cap: 15, now: () => SEP_2026 });
		expect(refusal.ok).toBe(false);
		expect(refusal.used).toBe(0);
	});

	it('allows a reservation that lands exactly on the cap', () => {
		const result = reserveProviderRequests('sky-scrapper', 15, { cap: 15, now: () => SEP_2026 });
		expect(result).toEqual({ ok: true, used: 15, cap: 15, monthKey: '2026-09' });
	});

	it('keeps separate providers on separate counters', () => {
		reserveProviderRequests('sky-scrapper', 15, { cap: 15, now: () => SEP_2026 });
		const flightsSky = reserveProviderRequests('flights-sky', 1, { cap: 40, now: () => SEP_2026 });
		expect(flightsSky).toEqual({ ok: true, used: 1, cap: 40, monthKey: '2026-09' });
	});

	it('resets the counter at a month boundary instead of carrying usage forward', () => {
		// August closes out nearly at cap...
		saveProviderQuotaState({ 'sky-scrapper': { monthKey: '2026-08', used: 14 } });

		// ...but a reservation made in September reads as a fresh month, because
		// the provider's own quota reset the moment the calendar month did.
		const result = reserveProviderRequests('sky-scrapper', 1, { cap: 15, now: () => SEP_2026 });
		expect(result).toEqual({ ok: true, used: 1, cap: 15, monthKey: '2026-09' });
	});

	it('would have refused the same reservation had the month not turned over', () => {
		saveProviderQuotaState({ 'sky-scrapper': { monthKey: '2026-08', used: 14 } });
		const result = reserveProviderRequests('sky-scrapper', 2, { cap: 15, now: () => AUG_2026 });
		expect(result.ok).toBe(false);
	});

	it('uses the stored/default cap when none is passed explicitly', () => {
		// sky-scrapper's default cap is 15 (see caps.ts) — the 16th request should be refused.
		for (let i = 0; i < 15; i++) reserveProviderRequests('sky-scrapper', 1, { now: () => SEP_2026 });
		const refusal = reserveProviderRequests('sky-scrapper', 1, { now: () => SEP_2026 });
		expect(refusal.ok).toBe(false);
		expect(refusal.cap).toBe(15);
	});
});

describe('getProviderQuotaSnapshot', () => {
	it('reports zero usage for a provider that has never been called', () => {
		expect(getProviderQuotaSnapshot('sky-scrapper', { cap: 15, now: () => SEP_2026 })).toEqual({
			providerId: 'sky-scrapper',
			monthKey: '2026-09',
			used: 0,
			cap: 15,
			remaining: 15
		});
	});

	it('reflects reservations already made this month', () => {
		reserveProviderRequests('sky-scrapper', 4, { cap: 15, now: () => SEP_2026 });
		expect(getProviderQuotaSnapshot('sky-scrapper', { cap: 15, now: () => SEP_2026 })).toEqual({
			providerId: 'sky-scrapper',
			monthKey: '2026-09',
			used: 4,
			cap: 15,
			remaining: 11
		});
	});

	it('never mutates stored usage just by being read', () => {
		getProviderQuotaSnapshot('sky-scrapper', { cap: 15, now: () => SEP_2026 });
		getProviderQuotaSnapshot('sky-scrapper', { cap: 15, now: () => SEP_2026 });
		expect(getProviderQuotaSnapshot('sky-scrapper', { cap: 15, now: () => SEP_2026 }).used).toBe(0);
	});

	it('reports a stale prior-month record as zero usage', () => {
		saveProviderQuotaState({ 'sky-scrapper': { monthKey: '2026-08', used: 14 } });
		expect(getProviderQuotaSnapshot('sky-scrapper', { cap: 15, now: () => SEP_2026 }).used).toBe(0);
	});
});
