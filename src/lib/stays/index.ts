/**
 * Public surface of the stay picker (issue #27) for whichever results/itinerary view
 * (issue #23/#24) ends up rendering it. Import from `$lib/stays` rather than reaching
 * into individual files, matching `$lib/components`'s own barrel.
 */

export { default as StayPicker } from './StayPicker.svelte';
export { femaleDormFit, femaleDormFitMessage, isFemaleDormSelectable } from './female-dorm-fit';
export type { FemaleDormFit } from './female-dorm-fit';
export { moneyDifference, stayTotalDelta, stayTotalForNights, formatMoney } from './pricing';
export { formatDistanceKm, haversineDistanceKm } from './distance';
export { ROOM_KIND_LABELS } from './room-kind';
export { cheapestSelectableOption, isOptionSelectable, rankProperties, selectableOptions } from './rank';
export { groupByProperty, propertyOf } from './types';
export { describeNoStays } from './no-stays-reason';
export type { NoStaysContext, NoStaysNotice, StayProviderOutcome } from './no-stays-reason';
export type { PropertyStayOptions, StayOption } from './types';
