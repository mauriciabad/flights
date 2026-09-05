/**
 * Issue #324: the connections map. Import from `$lib/connections-map`, not from the files
 * inside it.
 *
 * The dialog is the whole public surface. `ConnectionsMap` and `ConnectionsPanel` are
 * deliberately not exported: the map holds a MapLibre instance, and a second caller mounting
 * one outside a dialog is exactly what `tools/probe-map-cost.mjs` measured and what
 * `$lib/components`'s own note about `RouteMapDialog` refuses.
 */

export { default as ConnectionsMapDialog } from './ConnectionsMapDialog.svelte';
export { buildConnectionsMapModel, countByState } from './model';
export type {
	BookableConnection,
	ConnectionBlock,
	ConnectionOnMap,
	ConnectionState,
	ConnectionsMapInput,
	ConnectionsMapModel,
	UnpricedParts
} from './model';
export { describeBlock, describeUnpriced, pointLabel, spokenSummary, summariseConnections, STATE_LABEL } from './copy';
export type { BlockCopy } from './copy';
export { legCalendarFrom, readConnectionCalendar } from './calendar';
export type { CalendarDay, CalendarWindow, ConnectionCalendar, DayState, LegCalendar } from './calendar';
