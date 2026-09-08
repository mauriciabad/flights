import type { Locator } from '@playwright/test';
import { expect } from './fixtures';
import { readWindowPng } from '../../shared/read-png';
import { describeWindow, MAP_WINDOW_LIMITS } from '../../../src/lib/itinerary-map/basemap-canary';

/**
 * Waits until a map has actually drawn, which is later than every DOM signal it offers.
 *
 * MapLibre fires `load` once the style is parsed and one frame has rendered, and that is what
 * each of this app's three maps flips `mapReady` on. Tiles can still be missing at that point.
 * So `docs/screenshots/324-*.png` were pictures of the map container's own CSS colour. The
 * shot fired the moment the skeleton went, and until #443 the mocked style was one flat
 * colour, so nobody could see the difference between an undrawn map and a drawn one. The
 * first re-take after the fixture started drawing produced a dark route map with its grid and
 * a light one with nothing on it at all, from the same code, minutes apart.
 *
 * Two conditions, because either alone is satisfied by the wrong moment. The window has to
 * ink at least as much as the basemap canary's floor, which a blank rectangle does not. And
 * two consecutive shots have to agree, which rules out the frame where the route lines have
 * drawn and the basemap under them has not.
 */
export async function waitForMapPicture(map: Locator, timeout = 30_000): Promise<void> {
	let previous = '';
	await expect
		.poll(
			async () => {
				const shot = await map.screenshot();
				const inked = describeWindow(await readWindowPng(shot)).inkShare >= MAP_WINDOW_LIMITS.minInkShare;
				const same = previous === shot.toString('base64');
				previous = shot.toString('base64');
				return inked && same;
			},
			{ timeout, intervals: [250] }
		)
		.toBe(true);
}
