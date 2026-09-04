/**
 * One selectable stretch of an itinerary, shared between `ItineraryMap` (issue #26) and
 * `ItineraryTimeline` (issue #24) so a click on either side means the same thing on the
 * other. This is the whole contract between the two: a component that wants to
 * participate only needs this type and a bindable `selectedSegmentId` prop (see
 * `ItineraryMap.svelte`'s own doc comment for the exact shape expected of the other
 * side) — nothing here reaches into MapLibre, Svelte, or the timeline's own markup.
 *
 * Order matches the brief's own sequence, quoted in issue #24:
 * "Start at Origin location, Travel to origin airport, Waiting time at origin airport,
 * Fight to connection airport, Travel to connection hotel, Free time, Travel to
 * connection airport, Waiting time at connection airport, Flight to destination
 * airport, Travel to destination location" (docs/prompts/001-initial-brief.md,
 * lines 44-53).
 *
 * Values match `ItineraryTimeline.svelte` (issue #24, merged in PR #63) exactly: every
 * `<li>` there already carries a `data-segment` attribute set to one of these same
 * eleven strings — `origin-location`, `transfer-to-origin-airport`, `origin-waiting`,
 * `outbound-flight`, `transfer-to-hotel`, `free-time`, `transfer-to-connection-airport`,
 * `connection-waiting`, `onward-flight`, `transfer-to-destination-location`,
 * `destination-location` — checked directly against that component's source, not
 * inferred from its PR description. `ItineraryTimeline` does not (yet) expose a
 * `selectedSegmentId` prop or a click handler on those rows, so wiring it up is still
 * open work (see `ItineraryMap.svelte`'s doc comment), but whoever adds it can read
 * `event.currentTarget.dataset.segment` and assign it to the shared variable with no
 * translation step: the vocabulary already lines up.
 *
 * Waiting time and free time have no geography of their own — nothing moves — so they
 * key off the place they happen at rather than getting a segment of their own:
 * `'origin-waiting'` stands for the wait at the origin airport, `'free-time'` stands for
 * the free time at the hotel, `'connection-waiting'` stands for the wait at the
 * connection airport. The destination airport has no id at all: the brief's sequence
 * ends at "Travel to destination location" with no waiting-time row to hang a selection
 * on, so the map still draws it (a flight has to land somewhere) but it is never
 * independently selectable — see `ItineraryMapModel.extraWaypoints` in `segments.ts`.
 */
export type ItinerarySegmentId =
	| 'origin-location'
	| 'transfer-to-origin-airport'
	| 'origin-waiting'
	| 'outbound-flight'
	| 'transfer-to-hotel'
	| 'free-time'
	| 'transfer-to-connection-airport'
	| 'connection-waiting'
	| 'onward-flight'
	| 'transfer-to-destination-location'
	| 'destination-location';

/**
 * Canonical brief-sequence order. Not required by `ItineraryMap` itself (it only ever
 * sees the subset an `Itinerary` actually has), but exported so the timeline can render
 * rows in order without redefining the sequence a second time.
 */
export const ITINERARY_SEGMENT_ORDER: readonly ItinerarySegmentId[] = [
	'origin-location',
	'transfer-to-origin-airport',
	'origin-waiting',
	'outbound-flight',
	'transfer-to-hotel',
	'free-time',
	'transfer-to-connection-airport',
	'connection-waiting',
	'onward-flight',
	'transfer-to-destination-location',
	'destination-location'
];
