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
export { firstBookableStay, recommendedStay } from './recommended-bed';
export { groupByProperty, isSameProperty, propertyKey, propertyOf } from './types';
export { describePriceComparison, describeStayChoices, stayDistances } from './choice';
export type { StayChoice, StayChoiceContext, StayDistance, StayPriceComparison } from './choice';
export { describeNoStays } from './no-stays-reason';
export type { NoStaysContext, NoStaysNotice, StayProviderOutcome } from './no-stays-reason';
export type { PropertyStayOptions, StayOption } from './types';
