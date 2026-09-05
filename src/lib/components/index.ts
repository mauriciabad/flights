// Base components for the app. Import from `$lib/components` rather than
// reaching into individual files, so this list stays the one place that
// documents what the design system offers.
export { default as Button } from './Button.svelte';
export { default as Input } from './Input.svelte';
export { default as Select } from './Select.svelte';
export { default as Chip } from './Chip.svelte';
export { default as Flag } from './Flag.svelte';
export { default as Icon } from './Icon.svelte';
export type { IconName } from '$lib/data/tabler-icons.generated';
export { default as Card } from './Card.svelte';
export { default as AirlineLogo } from './AirlineLogo.svelte';
export { default as ModeIcon } from './ModeIcon.svelte';
export type { ModeIconKind } from './mode-icon';
export { transferIconKind } from './mode-icon';
export { default as TimeCell } from './TimeCell.svelte';
export { default as TripStrip } from './TripStrip.svelte';
export { default as StopoverBlock } from './StopoverBlock.svelte';
export { freeTimeDays } from './free-time-days';
export type { FreeTimeDays } from './free-time-days';
export { default as MetricRail } from './MetricRail.svelte';
export { default as PriceLine } from './PriceLine.svelte';
export { default as StopoverNights } from './StopoverNights.svelte';
export { ALL_METRIC_IDS, CARD_METRIC_IDS, itineraryMetrics, priceBreakdown } from './itinerary-metrics';
export type { ItineraryMetric, ItineraryMetricId, PriceBreakdown, PricePart } from './itinerary-metrics';
export { segmentIdOf, tripStrip } from './trip-strip';
export type { TripStrip as TripStripModel, TripStripSegment } from './trip-strip';
export { default as ItineraryMap } from './ItineraryMap.svelte';
// Issue #280's frozen previews. `RoutePreview` draws one; the other two are the surfaces
// that use it. `RouteMapDialog` is deliberately absent: it is `GroundLegPreviews`'s own
// business, and a second caller mounting a second MapLibre instance is the thing the
// measurement in `tools/probe-map-cost.mjs` exists to prevent.
export { default as RoutePreview } from './RoutePreview.svelte';
export { default as FlightDetour } from './FlightDetour.svelte';
export { default as GroundLegPreviews } from './GroundLegPreviews.svelte';
export { default as Skeleton } from './Skeleton.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as ErrorState, PROVIDER_ISSUE_COPY } from './ErrorState.svelte';
export type { ProviderIssueReason } from './ErrorState.svelte';
export { default as ItineraryTimeline } from './ItineraryTimeline.svelte';
export { default as FlightPicker } from './FlightPicker.svelte';
export { default as TransportPicker } from './TransportPicker.svelte';
export { default as WaitingTimeStepper } from './WaitingTimeStepper.svelte';
export { default as SegmentStub } from './SegmentStub.svelte';
