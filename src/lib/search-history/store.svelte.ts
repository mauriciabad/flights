import {
	clearHistory,
	loadHistory,
	normalizeQuery,
	recordSearch,
	removeSearch,
	saveHistory,
	type SearchHistoryEntry
} from './storage';

/**
 * The search history for the whole app lifetime, not one component tree: the results
 * page writes to it on every search it runs, and the search screen reads it from a
 * different route entirely. That is the case AGENTS.md names for a module-level rune
 * holder rather than plain `$state` inside a component, and it mirrors `KeyStore` next
 * door so there is one shape to learn for both.
 *
 * The class is exported alongside the singleton so a test can build a second instance
 * against the same `localStorage` and see what a reload would see.
 */
export class SearchHistoryStore {
	#entries = $state<SearchHistoryEntry[]>([]);

	constructor() {
		this.#entries = loadHistory();
	}

	get entries(): readonly SearchHistoryEntry[] {
		return this.#entries;
	}

	/**
	 * Files one run of a search. Takes the params rather than a string so every caller
	 * goes through `normalizeQuery` and two spellings of one search cannot become two
	 * rows. `now` is injectable for the same reason the validator takes `today`.
	 */
	record(params: URLSearchParams, now: number = Date.now()): void {
		const query = normalizeQuery(params);
		if (!query) return;
		const next = recordSearch(this.#entries, query, now);
		this.#entries = next;
		saveHistory(next);
	}

	remove(query: string): void {
		const next = removeSearch(this.#entries, query);
		if (next.length === this.#entries.length) return;
		this.#entries = next;
		if (next.length === 0) clearHistory();
		else saveHistory(next);
	}

	clear(): void {
		this.#entries = [];
		clearHistory();
	}
}

export const searchHistory = new SearchHistoryStore();
