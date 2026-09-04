export { DEFAULT_MAX_DELAY_MS, computeBackoffDelayMs, defaultSleep } from './backoff';
export type { BackoffOptions } from './backoff';
export {
	DEFAULT_PROVIDER_CAPS,
	FALLBACK_PROVIDER_CAP,
	clearProviderCapOverride,
	getProviderCap,
	setProviderCapOverride
} from './caps';
export { callProviderWithBudget } from './call-with-budget';
export type { CallProviderWithBudgetOptions } from './call-with-budget';
export { ProviderHttpError, defaultClassifyError, retryAfterSecondsOf } from './classify-error';
export { estimateWidenCost, runCostAwareSearch } from './cost-aware-search';
export type {
	CostAwareResultEntry,
	CostAwareSearchOptions,
	CostAwareSearchReport,
	CostAwareSearchResult,
	CostAwareSkip,
	CostAwareSource,
	ProviderTier
} from './cost-aware-search';
export { clearInFlightForTests, dedupeInFlight } from './dedupe';
export { monthKeyFor, secondsUntilNextMonthUtc } from './month-key';
export { isPermanentlyUnsubscribed, markNotSubscribed, resetPermanentFailuresForTests } from './permanent-failures';
export { getProviderQuotaSnapshot, reserveProviderRequests } from './quota';
export type { ProviderQuotaSnapshot, QuotaLookupOptions, ReserveResult } from './quota';
export { clearProviderQuotaStateForTests, loadProviderQuotaState, saveProviderQuotaState } from './quota-storage';
export type { ProviderQuotaRecord, ProviderQuotaState } from './quota-storage';
export type { ProviderError, ProviderErrorCode, ProviderId, ProviderResult, ProviderSource } from './types';
