/**
 * Issue #56: the search pipeline's public surface. Import from here, not from a sibling
 * file directly — `types.ts`, `pipeline.ts` etc. are implementation modules that may be
 * reshaped internally; this barrel is the seam the search form (issue #16) and the results
 * list (issue #23) are meant to depend on.
 */

export { runSearch, widenSearch, widenWithPriceCalendar } from './pipeline';
export { estimatePriceCalendarWidenCost } from './price-calendar';
export type { PriceCalendarDay, PriceCalendarOutcome, PriceCalendarQuery } from './price-calendar';
export { groupItineraryResults } from './group';
export { DEFAULT_STAY_RADIUS_KM } from './resources';

export type {
	ConnectionCandidate,
	ItineraryGroup,
	ItineraryResult,
	ItinerarySources,
	ProviderStatus,
	SearchDependencies,
	SearchQuery,
	SearchRunOptions,
	SearchSnapshot,
	SearchStage,
	WidenOption,
	WidenRequest,
	WidenTarget,
	WidenTier
} from './types';
