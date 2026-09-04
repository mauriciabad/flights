export {
	clearHistory,
	loadHistory,
	MAX_HISTORY_ENTRIES,
	normalizeQuery,
	recordSearch,
	removeSearch,
	saveHistory
} from './storage';
export type { SearchHistoryEntry } from './storage';
export { formatDateRange, formatTravellers, summarizeSearch } from './summary';
export type { SearchSummary } from './summary';
export { searchHistory, SearchHistoryStore } from './store.svelte';
export { default as RecentSearches } from './RecentSearches.svelte';
