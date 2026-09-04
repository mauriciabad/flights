import { beforeEach, describe, expect, it } from 'vitest';
import {
	clearHistory,
	loadHistory,
	MAX_HISTORY_ENTRIES,
	normalizeQuery,
	recordSearch,
	removeSearch,
	saveHistory,
	type SearchHistoryEntry
} from './storage';

const STORAGE_KEY = 'flights.searchHistory.v1';

function entry(query: string, lastRunAt: number): SearchHistoryEntry {
	return { query, lastRunAt };
}

describe('normalizeQuery', () => {
	it('is the same string for the same search written in a different order', () => {
		const a = new URLSearchParams('from=BCN&to=OTP&dep=2026-10-01&arr=2026-10-20');
		const b = new URLSearchParams('arr=2026-10-20&dep=2026-10-01&to=OTP&from=BCN');
		expect(normalizeQuery(a)).toBe(normalizeQuery(b));
	});

	it('drops empty params so a trailing "&via=" is not a different search', () => {
		expect(normalizeQuery(new URLSearchParams('from=BCN&via='))).toBe('from=BCN');
	});

	it('keeps repeated keys rather than collapsing them', () => {
		expect(normalizeQuery(new URLSearchParams('via=VIE&via=BER'))).toBe('via=BER&via=VIE');
	});
});

describe('recordSearch', () => {
	it('puts a new search at the top', () => {
		const entries = recordSearch([entry('from=BCN', 1)], 'from=OTP', 2);
		expect(entries.map((item) => item.query)).toEqual(['from=OTP', 'from=BCN']);
	});

	it('moves a repeat to the top instead of adding a second row', () => {
		const entries = recordSearch([entry('a', 1), entry('b', 2)], 'a', 3);
		expect(entries).toEqual([entry('a', 3), entry('b', 2)]);
	});

	it('drops the oldest once the list is full', () => {
		let entries: SearchHistoryEntry[] = [];
		for (let i = 0; i < MAX_HISTORY_ENTRIES + 3; i += 1) {
			entries = recordSearch(entries, `q=${i}`, i);
		}
		expect(entries).toHaveLength(MAX_HISTORY_ENTRIES);
		expect(entries[0].query).toBe(`q=${MAX_HISTORY_ENTRIES + 2}`);
		expect(entries.some((item) => item.query === 'q=0')).toBe(false);
	});

	it('ignores an empty query', () => {
		expect(recordSearch([entry('a', 1)], '', 2)).toEqual([entry('a', 1)]);
	});
});

describe('removeSearch', () => {
	it('takes out exactly the one asked for', () => {
		expect(removeSearch([entry('a', 1), entry('b', 2)], 'a')).toEqual([entry('b', 2)]);
	});
});

describe('localStorage round trip', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('reads back what it wrote, newest first', () => {
		saveHistory([entry('a', 1), entry('b', 2)]);
		expect(loadHistory()).toEqual([entry('b', 2), entry('a', 1)]);
	});

	it('reads an empty history when nothing was ever saved', () => {
		expect(loadHistory()).toEqual([]);
	});

	it('reads an empty history rather than throwing on corrupt data', () => {
		localStorage.setItem(STORAGE_KEY, '{not json');
		expect(loadHistory()).toEqual([]);
	});

	it('drops entries of the wrong shape and keeps the rest', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([{ query: 'a', lastRunAt: 5 }, { query: 7 }, null, { lastRunAt: 3 }])
		);
		expect(loadHistory()).toEqual([entry('a', 5)]);
	});

	it('never hands back more than the cap, even if the stored file is longer', () => {
		const stored = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, i) => entry(`q=${i}`, i));
		localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
		expect(loadHistory()).toHaveLength(MAX_HISTORY_ENTRIES);
	});

	it('forgets everything on clear', () => {
		saveHistory([entry('a', 1)]);
		clearHistory();
		expect(loadHistory()).toEqual([]);
	});
});
