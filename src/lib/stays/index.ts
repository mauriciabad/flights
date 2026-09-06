/**
 * Public surface of the stay picker (issue #27) for whichever results/itinerary view
 * (issue #23/#24) ends up rendering it. Import from `$lib/stays` rather than reaching
 * into individual files, matching `$lib/components`'s own barrel.
 */

export { default as StayPicker } from './StayPicker.svelte';
export { default as PickedBed } from './PickedBed.svelte';
export { default as PhotoCarousel } from './PhotoCarousel.svelte';
export { default as StaysMapDialog } from './StaysMapDialog.svelte';
export {
	genderFit,
	genderFitMessage,
	isGenderFitSelectable,
	isStayBookableByGroup,
	stayGenderFit,
	stayGenderFitMessage,
	stayRestrictedTo
} from './gendered-room-fit';
export type { GenderFit, RoomGenderRestriction } from './gendered-room-fit';
export { bedNightlyRate, moneyDifference, stayTotalDelta, stayTotalForNights, formatMoney } from './pricing';
export type { NightlyRate } from './pricing';
export { formatDistanceKm, haversineDistanceKm } from './distance';
export { ROOM_KIND_LABELS } from './room-kind';
export { cheapestSelectableOption, isOptionSelectable, rankProperties, selectableOptions } from './rank';
export type { StopoverForRanking } from './rank';
export { firstBookableStay, recommendedStay, stopoverForRanking } from './recommended-bed';
export { groupByProperty, isSameBed, isSameProperty, propertyKey, propertyOf } from './types';
export { describePriceComparison, describeStayChoices, showsWholeStayFigures, stayDistances } from './choice';
export type { StayChoice, StayChoiceContext, StayDistance, StayPriceComparison } from './choice';
export {
	REACH_MODES,
	TRANSIT_NOT_BATCHABLE_NOTE,
	UNASKED_REACH,
	describeModeReach,
	describeStayReach,
	judgeReach,
	reachIsPending,
	reachLimitMinutes,
	stayReachNote,
	stayReachPoints,
	walkCouldBePlausible
} from './reach';
export type { ModeReach, ReachMode, ReachPoint, StayReach } from './reach';
export { fetchStayReach, pendingReach, stayReachTargets } from './fetch-reach';
export type { ReachLookupResult, ReachTarget } from './fetch-reach';
export {
	STAY_SORT_KEYS,
	STAY_SORT_LABELS,
	availableStaySortKeys,
	sortStayChoices,
	staySortValue
} from './sort';
export type { StaySortKey } from './sort';
export { describeNoStays, describeStayCatalogue } from './no-stays-reason';
export type {
	NoStaysContext,
	NoStaysNotice,
	StayCatalogueContext,
	StayCatalogueNote,
	StayProviderOutcome
} from './no-stays-reason';
export type { PropertyStayOptions, StayOption } from './types';
