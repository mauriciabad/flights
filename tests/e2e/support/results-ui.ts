import type { Locator, Page } from '@playwright/test';

/**
 * The three gestures every results-page spec needs, in one place.
 *
 * Before issue #278 there was one: click "Show details" and everything was inside
 * `.result-detail`. #278 moved every control to a panel beside the list and made the trip
 * strip's caption unfold a second timeline inside the card. #440 deleted that fold and moved
 * the timeline into the panel as well.
 *
 * Twenty-five specs reach for these, and twenty-five copies of "which class is the unfold
 * button" is how a restructure turns into a day of test edits. This file is why #440 changed
 * one gesture rather than twenty-five.
 */

/**
 * Puts the first card's full timeline on screen, which since issue #440 means filling the
 * trip inspector with that card and opening the timeline inside it.
 *
 * The stopover cell by preference, because its panel is the stopover's and that is what most
 * of the specs calling this go on to read. A connection with no night in it is a wait at the
 * airport (issue #426), and the strip draws a wait rather than free time there, so it has no
 * stopover cell at all; the outbound flight is the one cell every itinerary has, and it is
 * the fallback.
 *
 * The timeline is already open on a wide viewport and closed inside the phone sheet, so the
 * disclosure is pressed only when it is shut.
 */
export async function openTimeline(page: Page, card: Locator = page.locator('.result-card').first()) {
	await card.locator('.trip-strip-track').first().waitFor();
	const stopover = card.locator('.trip-strip-hit-stopover').first();
	const cell = (await stopover.count()) > 0 ? stopover : card.locator('.trip-strip-hit-flight').first();
	await cell.click();
	const summary = page.locator('.customiser-trip-summary');
	await summary.waitFor();
	if ((await page.locator('.customiser-trip[open]').count()) === 0) await summary.click();
	await page.locator('.itinerary-timeline').waitFor();
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
 * Picks one stretch of the trip from the timeline, by `ItinerarySegmentId`. Since issue #440
 * that timeline is inside the inspector, so `openTimeline` has to have run first.
 *
 * Deliberately clicks the row's top-left corner rather than its centre. A row's centre can
 * be the waiting-time stepper, and `ItineraryTimeline.handleRowClick` ignores clicks that
 * land on a control inside the row: issue #141's third defect was minus and plus bubbling
 * up to select the row and fly the map, so four nudges of a buffer threw the traveller's
 * panned view away four times.
 */
export async function pickTimelineSegment(page: Page, segment: string) {
	const row = page.locator(`.itinerary-timeline [data-segment="${segment}"]`);
	await row.waitFor();
	// A second activation of the selected row clears the selection, which is how a traveller
	// hands the map back the whole route. That makes a bare click the wrong gesture for
	// "show me this step": `openTimeline` picks the stopover on the way in, so a spec asking
	// for the stopover next would empty the panel it just filled. Every caller here means
	// select, so this asks whether the row already is the selection first.
	if ((await row.getAttribute('aria-current')) === 'true') return;
	await row.click({ position: { x: 6, y: 6 } });
}

/** The customise panel, wherever it currently lives. One instance is mounted at a time, so
 * this resolves to the rail on a wide viewport and the sheet on a narrow one. */
export function customiser(page: Page): Locator {
	return page.getByTestId('segment-customiser');
}

/**
 * How many MapLibre canvases are on the page that a traveller could be looking at, which is
 * every attached one except the hidden renderer's.
 *
 * One hidden instance draws the ground previews' basemaps off-screen
 * (`map-snapshot.svelte.ts`), and it comes and goes on its own: built by the first preview
 * that asks and released `IDLE_RELEASE_MS` after the queue empties. A spec counting raw
 * canvases to prove a dialog does not leak reads that timer instead, which is what issue
 * #455 turned out to be. So it is excluded here by ancestry, and the property that there is
 * only ever one of it is pinned separately, in `route-previews.spec.ts`, which counts raw
 * canvases across a whole settle for exactly that reason.
 *
 * Read the name loosely. This counts what is attached, and a `<dialog>` that has fired
 * `close` is still attached until the parent stops rendering it, so a count here can be 1
 * for the moment between the two. That is why the assertions after Escape poll for 0.
 */
export async function visibleMapCanvases(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			[...document.querySelectorAll('canvas.maplibregl-canvas')].filter(
				(canvas) => canvas.closest('.map-snapshot-renderer') === null
			).length
	);
}
