import { beforeEach, describe, expect, it } from 'vitest';
import { clearProviderQuotaStateForTests, loadProviderQuotaState, saveProviderQuotaState } from './quota-storage';

beforeEach(() => {
	localStorage.clear();
});

describe('loadProviderQuotaState / saveProviderQuotaState', () => {
	it('round-trips through localStorage', () => {
		saveProviderQuotaState({ 'sky-scrapper': { monthKey: '2026-09', used: 3 } });
		expect(loadProviderQuotaState()).toEqual({ 'sky-scrapper': { monthKey: '2026-09', used: 3 } });
	});

	it('reads as empty when nothing has been saved yet', () => {
		expect(loadProviderQuotaState()).toEqual({});
	});

	it('reads as empty rather than throwing on corrupted JSON', () => {
		localStorage.setItem('flights.providerBudget.v1', 'not json{{{');
		expect(loadProviderQuotaState()).toEqual({});
	});

	it('drops malformed per-provider records instead of returning something the rest of the app cannot use', () => {
		localStorage.setItem(
			'flights.providerBudget.v1',
			JSON.stringify({
				'sky-scrapper': { monthKey: '2026-09', used: 3 },
				broken: { monthKey: '2026-09' }, // missing `used`
				alsoBroken: 'not an object'
			})
		);
		expect(loadProviderQuotaState()).toEqual({ 'sky-scrapper': { monthKey: '2026-09', used: 3 } });
	});
});

describe('clearProviderQuotaStateForTests', () => {
	it('removes everything that was saved', () => {
		saveProviderQuotaState({ 'sky-scrapper': { monthKey: '2026-09', used: 3 } });
		clearProviderQuotaStateForTests();
		expect(loadProviderQuotaState()).toEqual({});
	});
});
