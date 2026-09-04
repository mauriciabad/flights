/**
 * What the map says it is showing (issue #141).
 *
 * `ItineraryMap` used to build this string inline, and it had a hole: any selectable step
 * the model has no geometry for produced the empty string. Selecting "Travel to the
 * stopover" on an itinerary with no bed priced left the line blank, the camera still, and
 * the `role="status"` region silent, so nobody sighted or otherwise was told what had
 * happened. Every branch below returns a real sentence, and the tests pin that.
 *
 * Pure on purpose: the sentence a traveller reads is worth more than the sum of the tests
 * that could be written for a Svelte component around it, and this way it is checkable
 * without a browser.
 */

import type { ItineraryMapModel } from './segments';
import { findSegment } from './segments';
import type { ItinerarySegmentId } from './segment-id';

/** The tone strip beside the status text: which of the map's two colours the selection
 *  belongs to, or `'none'` for a step that has nothing drawn to point at. */
export type ItineraryMapStatusTone = 'neutral' | 'stopover' | 'none';

export interface ItineraryMapStatus {
	text: string;
	tone: ItineraryMapStatusTone;
	/** True when the status is explaining an absence rather than naming what is drawn.
	 *  Drives the muted, hollow-swatch treatment, so the two read differently at a
	 *  glance and not only by their wording (WCAG: never colour alone, and never
	 *  wording alone either). */
	isAbsence: boolean;
}

export const WHOLE_ROUTE_STATUS: ItineraryMapStatus = {
	text: 'Showing the whole route.',
	tone: 'neutral',
	isAbsence: false
};

export function itineraryMapStatus(
	model: ItineraryMapModel,
	selectedSegmentId: ItinerarySegmentId | null
): ItineraryMapStatus {
	if (!selectedSegmentId) return WHOLE_ROUTE_STATUS;

	const segment = findSegment(model, selectedSegmentId);
	if (segment) {
		// The stopover with no bed priced is the one point whose coordinates are a city
		// rather than an address (`segments.ts`, `ItineraryPointPrecision`). Saying so is
		// what stops the traveller reading a runway-centred view as "your free time
		// happens here".
		const cityCaveat =
			segment.kind === 'point' && segment.precision === 'city'
				? ' No bed priced, so this is the connection city, not an address.'
				: '';
		return { text: `Showing ${segment.label}.${cityCaveat}`, tone: segment.tone, isAbsence: false };
	}

	const note = model.absentSegmentNotes[selectedSegmentId];
	if (note) return { text: note, tone: 'none', isAbsence: true };

	// A selection from an itinerary that changed underneath it: the id is real but this
	// model never had it and never explained it either. Rare, and still not silence.
	return { text: 'Nothing to draw. This step is not part of the itinerary on screen.', tone: 'none', isAbsence: true };
}
