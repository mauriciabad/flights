import type { Locator, Page } from '@playwright/test';

/**
 * The three gestures every results-page spec needs after issue #278, in one place.
 *
 * Before it there was one: click "Show details" and everything was inside `.result-detail`.
 * The card no longer opens; the trip strip unfolds into the full timeline, and every
 * control moved to a panel beside the list (a rail above 64rem, a sheet below it). Eight
 * specs reach for those, and eight copies of "which class is the unfold button" is how a
 * restructure turns into a day of test edits.
 */

/** Unfolds the full timeline under the first card's trip strip. The control is the strip's
 * own stopover caption, whose accessible name starts with the visible words ("1 night in
 * Vienna") and so cannot be matched by a fixed string. */
export async function openTimeline(page: Page, card: Locator = page.locator('.result-card').first()) {
	await card.locator('.trip-strip-unfold').click();
}

/** Picks one stretch of the trip on the strip, which is what fills the customise panel.
 * `kind` is the strip's own target vocabulary, not the timeline's. */
export async function pickStripSegment(
	page: Page,
	kind: 'flight' | 'wait' | 'transport' | 'stopover',
	index = 0
) {
	await page.locator(`.trip-strip-hit-${kind}`).nth(index).click();
}

/**
 * Picks one stretch of the trip from the unfolded timeline, by `ItinerarySegmentId`.
 *
 * Deliberately clicks the row's top-left corner rather than its centre. A row's centre can
 * be the waiting-time stepper, and `ItineraryTimeline.handleRowClick` ignores clicks that
 * land on a control inside the row: issue #141's third defect was minus and plus bubbling
 * up to select the row and fly the map, so four nudges of a buffer threw the traveller's
 * panned view away four times.
 */
export async function pickTimelineSegment(page: Page, segment: string) {
	await page
		.locator(`.itinerary-timeline [data-segment="${segment}"]`)
		.click({ position: { x: 6, y: 6 } });
}

/** The customise panel, wherever it currently lives. One instance is mounted at a time, so
 * this resolves to the rail on a wide viewport and the sheet on a narrow one. */
export function customiser(page: Page): Locator {
	return page.getByTestId('segment-customiser');
}
