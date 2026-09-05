/**
 * Issue #56: the search pipeline's public surface. Import from here, not from a sibling
 * file directly — `types.ts`, `pipeline.ts` etc. are implementation modules that may be
 * reshaped internally; this barrel is the seam the search form (issue #16) and the results
 * list (issue #23) are meant to depend on.
 */

export { runSearch, widenSearch, widenWithPriceCalendar } from './pipeline';
export { confirmTargetFor, narrowToConfirmTarget } from './confirm-target';
export { estimatePriceCalendarWidenCost } from './price-calendar';
export type { PriceCalendarDay, PriceCalendarOutcome, PriceCalendarQuery } from './price-calendar';
export { groupItineraryResults } from './group';
export { SourceTracker, providerAnswer } from './provenance';
export type { ProviderAnswer } from './provenance';
export { DEFAULT_STAY_RADIUS_KM, pickLandingToTransportTime } from './resources';

export type {
	ConnectionCandidate,
	ConnectionTransferOptions,
	DepartureWindow,
	ItineraryGroup,
	ItineraryResult,
	ItinerarySources,
	OuterTransferOptions,
	ProviderStatus,
	SearchDependencies,
	SearchQuery,
	SearchRunOptions,
	SearchSnapshot,
	SearchStage,
	TransferLegOptions,
	TransitLegAnswer,
	TransitLegAnswers,
	WidenOption,
	WidenRequest,
	WidenTarget,
	WidenTier,
	WithheldRoutes,
	WithheldTransfers
} from './types';

/** Issue #267: routing the two in-city legs for a bed the pipeline never picked, so the
 * detail panel can answer a swap with a real journey instead of "nothing routed here". */
export { routeToProperty } from './route-to-property';
export type { PropertyRouting, RouteToPropertyInput } from './route-to-property';

/** Issue #267: the timetable half of the same swap, asked only when a traveller asks for
 * it, and drawing from the search's own ration rather than a second one. */
export {
	MAX_TRANSIT_LOOKUPS_PER_SEARCH,
	TRANSIT_LEGS_TO_A_PROPERTY,
	createTransitLookupBudget,
	fetchTransitSchedules
} from './transit-schedule';
export type { TransitLookupBudget, TransitScheduleOutcome } from './transit-schedule';
