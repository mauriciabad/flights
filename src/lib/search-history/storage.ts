/**
 * The searches this browser has actually run, newest first.
 *
 * The owner asked for it: "searches should be saved in some history [...] you first pick
 * the search and then shows results". A search is exactly the query string the results
 * page already reads, so an entry stores that and nothing else. Reconstructing a search
 * is then `/results/?<entry.query>` with no lossy summary in between.
 *
 * Same rules as the keys store next door: `localStorage` only, every access wrapped,
 * anything unreadable reads as "no history" rather than throwing.
 */

/** Namespaced the same way `flights.byokKeys.v1` is, so neither can shadow the other. */
const STORAGE_KEY = 'flights.searchHistory.v1';

/**
 * Small enough to read at a glance on a phone and small enough that yesterday's typo
 * falls off the end on its own. The brief for this work: "do not make it a trap that
 * hoards every typo forever."
 */
export const MAX_HISTORY_ENTRIES = 8;

export interface SearchHistoryEntry {
	/** URL search params for `/results/`, normalised by `normalizeQuery` so the same
	 * search is the same string no matter which order the params were written in. */
	query: string;
	/** Epoch milliseconds of the last time this search was run. Re-running an old search
	 * moves it back to the top rather than adding a second row for it. */
	lastRunAt: number;
}

/**
 * Sorted by key then value, so two URLs describing one search collapse to one entry.
 * `fieldsToSearchParams` writes a fixed order today, but a hand-edited or hand-typed
 * link does not, and neither does a param the codec gains later.
 */
export function normalizeQuery(params: URLSearchParams): string {
	const pairs = [...params.entries()].filter(([, value]) => value !== '');
	pairs.sort(([keyA, valueA], [keyB, valueB]) =>
		keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB)
	);
	return new URLSearchParams(pairs).toString();
}

function readRaw(): string | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeRaw(raw: string): boolean {
	try {
		if (typeof localStorage === 'undefined') return false;
		localStorage.setItem(STORAGE_KEY, raw);
		return true;
	} catch {
		return false;
	}
}

/** Never throws. A corrupt file, a half-written entry or a missing key all read as an
 * empty history, because losing the list is a smaller harm than a page that will not
 * load. */
export function loadHistory(): SearchHistoryEntry[] {
	const raw = readRaw();
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const entries: SearchHistoryEntry[] = [];
		for (const item of parsed) {
			if (typeof item !== 'object' || item === null) continue;
			const { query, lastRunAt } = item as Record<string, unknown>;
			if (typeof query !== 'string' || query === '') continue;
			if (typeof lastRunAt !== 'number' || !Number.isFinite(lastRunAt)) continue;
			entries.push({ query, lastRunAt });
		}
		return sortAndCap(entries);
	} catch {
		return [];
	}
}

export function saveHistory(entries: readonly SearchHistoryEntry[]): boolean {
	try {
		return writeRaw(JSON.stringify(entries));
	} catch {
		return false;
	}
}

export function clearHistory(): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to roll back to, and nothing the caller could do about it.
	}
}

function sortAndCap(entries: readonly SearchHistoryEntry[]): SearchHistoryEntry[] {
	return [...entries].sort((a, b) => b.lastRunAt - a.lastRunAt).slice(0, MAX_HISTORY_ENTRIES);
}

/**
 * Newest first, one row per distinct search. Running a search you have run before moves
 * it to the top instead of adding a duplicate, which is the difference between a list
 * you can use and a log you have to read.
 */
export function recordSearch(
	entries: readonly SearchHistoryEntry[],
	query: string,
	now: number
): SearchHistoryEntry[] {
	if (!query) return [...entries];
	const withoutThisOne = entries.filter((entry) => entry.query !== query);
	return sortAndCap([{ query, lastRunAt: now }, ...withoutThisOne]);
}

export function removeSearch(
	entries: readonly SearchHistoryEntry[],
	query: string
): SearchHistoryEntry[] {
	return entries.filter((entry) => entry.query !== query);
}
