import { beforeEach, describe, expect, it } from 'vitest';
import { SearchHistoryStore } from './store.svelte';

beforeEach(() => {
	localStorage.clear();
});

const BCN_OTP = new URLSearchParams('dep=2026-10-01&arr=2026-10-20&from=BCN&to=OTP');
const BVC_PFO = new URLSearchParams('dep=2026-10-06&arr=2026-10-12&from=BVC&to=PFO');

describe('SearchHistoryStore', () => {
	it('remembers a search across a reload', () => {
		new SearchHistoryStore().record(BCN_OTP, 1000);

		// A second instance over the same localStorage is what a page load sees.
		const afterReload = new SearchHistoryStore();
		expect(afterReload.entries).toHaveLength(1);
		expect(afterReload.entries[0].query).toBe('arr=2026-10-20&dep=2026-10-01&from=BCN&to=OTP');
	});

	it('lists the most recent search first', () => {
		const store = new SearchHistoryStore();
		store.record(BCN_OTP, 1000);
		store.record(BVC_PFO, 2000);
		expect(store.entries.map((entry) => entry.query.includes('BVC'))).toEqual([true, false]);
	});

	it('re-running an old search moves it up rather than duplicating it', () => {
		const store = new SearchHistoryStore();
		store.record(BCN_OTP, 1000);
		store.record(BVC_PFO, 2000);
		store.record(BCN_OTP, 3000);
		expect(store.entries).toHaveLength(2);
		expect(store.entries[0].query).toContain('BCN');
	});

	it('the same search written with its params in another order is one entry', () => {
		const store = new SearchHistoryStore();
		store.record(new URLSearchParams('from=BCN&to=OTP&dep=2026-10-01&arr=2026-10-20'), 1000);
		store.record(new URLSearchParams('arr=2026-10-20&to=OTP&dep=2026-10-01&from=BCN'), 2000);
		expect(store.entries).toHaveLength(1);
	});

	it('a removed entry stays gone after a reload', () => {
		const store = new SearchHistoryStore();
		store.record(BCN_OTP, 1000);
		store.record(BVC_PFO, 2000);
		store.remove(store.entries[0].query);

		expect(new SearchHistoryStore().entries).toHaveLength(1);
	});

	it('clearing empties the list and the storage behind it', () => {
		const store = new SearchHistoryStore();
		store.record(BCN_OTP, 1000);
		store.clear();

		expect(store.entries).toEqual([]);
		expect(new SearchHistoryStore().entries).toEqual([]);
	});

	it('ignores a search with no params at all', () => {
		const store = new SearchHistoryStore();
		store.record(new URLSearchParams(), 1000);
		expect(store.entries).toEqual([]);
	});
});
